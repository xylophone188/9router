/**
 * Worker/Advisor 双层架构
 *
 * Worker 层（脏活累活）：
 * - NVIDIA 3 keys x 40 req/min = 120 req/min
 * - 每个键并发前两个智力模型，失败则第三第四个
 * - Redis 限流：每分钟每 key 40 次
 * - 免费供应商降级链：OpenRouter → LongCat → Cloudflare → Moark → Cohere → Cerebras → Ollama → MiMo
 *
 * Advisor 层（智力审核）：
 * - Worker 输出 → Advisor 审核输入换输出（缓存友好）
 * - "1" = 行，修改建议 = 不行
 * - 完成后再让 Advisor 再看看对不对
 * - 按智力排名降级：claude-opus-4-8 → gpt-5.5 → gpt-5.4 → kimi-for-coding
 *
 * Paid Worker（最后兜底）：
 * - Claude 订阅：5h session, 100 req cap ≈ 20 req/h
 */

// ============================================
// 限额配置（基于用户提供的实际限额）
// ============================================

const PROVIDER_LIMITS = {
  nvidia: {
    keys: 3,
    reqPerMin: 40,
    models: [
      'nvidia/nemotron-3-super-120b-a12b:free',        // 高智力
      'nvidia/nemotron-3-ultra-550b-a55b:free',        // 最高智力
      'nvidia/nemotron-3-nano-30b-a3b:free',           // 备用
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free' // 备用
    ]
  },
  kilocode: {
    // Kilo docs: anonymous free = 200 req/hour/IP; authenticated OAuth exact quota is not public.
    // Treat each active OAuth connection as a separate free worker with conservative 40 req/min local cap.
    keys: 5,
    reqPerHourAnonymous: 200,
    reqPerMin: 40,
    models: [
      'kilo-auto/free',
      'poolside/laguna-m.1:free',
      'nex-agi/nex-n2-pro:free',
      'stepfun/step-3.7-flash:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'poolside/laguna-xs.2:free',
      'nvidia/nemotron-3.5-content-safety:free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'openrouter/owl-alpha',
      'openrouter/free'
    ]
  },
  openrouter: {
    keys: 2,
    reqPerDay: 1000,
    models: [
      'openrouter/openrouter/owl-alpha',               // 高智力
      'openrouter/moonshotai/kimi-k2.6:free'            // 免费高智力
    ]
  },
  longcat: {
    reqPerDay: 2000,
    reqPerModel: 200,  // 单模型 200 次
    models: ['longcat/LongCat-2.0-Preview']
  },
  cloudflare: {
    tokenPerDay: 10000,  // Workers AI free tier
    models: ['@cf/moonshotai/kimi-k2.6']
  },
  moark: {
    unitsPerDay: 1000,
    models: ['GLM-4.7-Flash']
  },
  cohere: {
    unitsPerDay: 1000,
    models: ['cohere/command-r-plus-08-2024']
  },
  cerebras: {
    // rpm/tpm/rpd/tpd 都有，32K 上下文
    rpm: 15,
    models: ['cerebras/gpt-oss-120b', 'cerebras/zai-glm-4.7']
  },
  ollama: {
    // 1 cloud model at a time (limits reset every 5h & 7d)
    models: ['ollama/gpt-oss:120b', 'ollama/minimax-m2.5']
  },
  mimo: {
    // MiMo Code Free
    models: ['mmf/mimo-auto']
  }
};

// Advisor 模型降级链（按智力排序）
const ADVISOR_MODELS = [
  { provider: 'claude', models: ['claude-opus-4-8'] },              // 最高智力
  { provider: 'tkmyself-claude', models: ['gpt-5.5', 'gpt-5.4'] },  // 高智力
  { provider: 'kimi', models: ['kimi-for-coding'] }                 // 兜底
];

// ============================================
// Redis 限流器
// ============================================

class RateLimiter {
  constructor(redis) {
    this.redis = redis;
  }

  /**
   * 检查并增加请求计数
   * @param {string} key - Redis key (providerId|keyIndex)
   * @param {number} limit - 限额（如 40 req/min）
   * @param {number} window - 时间窗口（毫秒，默认 60000 = 1min）
   * @returns {Promise<{allowed: boolean, remaining: number, resetAt: number}>}
   */
  async checkAndIncrement(key, limit = 40, window = 60000) {
    const now = Date.now();
    const windowStart = now - window;

    // 使用 Redis sorted set 实现滑动窗口
    const redisKey = `rate_limit:${key}`;

    try {
      // 移除窗口外的计数
      await this.redis.zremrangebyscore(redisKey, 0, windowStart);

      // 获取当前窗口内的请求数
      const count = await this.redis.zcard(redisKey);

      if (count >= limit) {
        // 获取最早的请求时间（用于计算重置时间）
        const earliest = await this.redis.zrange(redisKey, 0, 0, 'WITHSCORES');
        const resetAt = earliest ? parseFloat(earliest[1]) + window : now + window;
        return { allowed: false, remaining: 0, resetAt };
      }

      // 增加当前请求
      await this.redis.zadd(redisKey, now, `${now}:${Math.random()}`);
      // 设置过期时间（防止 key 永久存在）
      await this.redis.expire(redisKey, window / 1000 + 60);

      return { allowed: true, remaining: limit - count - 1, resetAt: now + window };
    } catch (error) {
      console.error('RateLimiter checkAndIncrement error', { key, error });
      // 降级：失败时允许通过（避免影响主流程）
      return { allowed: true, remaining: limit - 1, resetAt: now + window };
    }
  }

  /**
   * 重置指定 key 的计数
   */
  async reset(key) {
    await this.redis.del(`rate_limit:${key}`);
  }
}

// ============================================
// Provider 层管理器
// ============================================

class ProviderTiers {
  constructor(redis) {
    this.redis = redis;
    this.rateLimiter = new RateLimiter(redis);
  }

  /**
   * 获取 Worker 层的 provider 列表（按优先级排序）
   * @returns {Promise<Array<{providerId, keyIndex, provider, models, limits}>>}
   */
  async getWorkerProviders() {
    const providers = [];

    // 1. NVIDIA 3 keys
    const nvidiaIds = ['12e7b4fd-d648-442c-9226-21187133cc65', 'e60ffd7b-4da5-4ebf-a096-41bc1c6f0b0f', '3bf2e47e-962c-4ef1-883e-4b1a6e781c65'];
    for (let i = 0; i < nvidiaIds.length; i++) {
      providers.push({
        providerId: nvidiaIds[i],
        keyIndex: i,
        provider: 'nvidia',
        models: PROVIDER_LIMITS.nvidia.models,
        limits: { reqPerMin: PROVIDER_LIMITS.nvidia.reqPerMin }
      });
    }

    // 2. Kilo Code free OAuth pool (5 active accounts)
    const kilocodeIds = [
      '7a8fc05f-13f3-4134-8a29-423cec5607f9',
      '8e3a9769-ea27-405c-b0fb-8d2955a32f42',
      'b9cdea58-6919-4fd3-ab9b-3a37df568aa8',
      'b4d92993-4168-4301-80df-6f42697ce64d',
      '14fd8492-ab21-443b-976e-38a57bcbfe40'
    ];
    for (let i = 0; i < kilocodeIds.length; i++) {
      providers.push({
        providerId: kilocodeIds[i],
        keyIndex: i,
        provider: 'kilocode',
        models: PROVIDER_LIMITS.kilocode.models,
        limits: { reqPerMin: PROVIDER_LIMITS.kilocode.reqPerMin, reqPerHourAnonymous: PROVIDER_LIMITS.kilocode.reqPerHourAnonymous }
      });
    }

    // 3. OpenRouter 2 keys
    const openrouterIds = ['dc9d6846-ca7f-465b-ab83-5f9966fd6d86', '42840c6c-981d-48d2-8d57-72f18a2cd642'];
    for (let i = 0; i < openrouterIds.length; i++) {
      providers.push({
        providerId: openrouterIds[i],
        keyIndex: i,
        provider: 'openrouter',
        models: PROVIDER_LIMITS.openrouter.models,
        limits: { reqPerDay: PROVIDER_LIMITS.openrouter.reqPerDay }
      });
    }

    // 3. 其他免费供应商（降级链）
    const fallbackProviders = [
      { providerId: 'd818a55d-9da7-4061-a748-6f88a7fe83b8', provider: 'longcat', models: PROVIDER_LIMITS.longcat.models, limits: { reqPerDay: PROVIDER_LIMITS.longcat.reqPerDay } },
      { providerId: '21a364bd-c738-4ccd-82d8-1080c2cfc9a8', provider: 'cloudflare', models: PROVIDER_LIMITS.cloudflare.models, limits: { tokenPerDay: PROVIDER_LIMITS.cloudflare.tokenPerDay } },
      { providerId: 'ea2dc673-47f8-4920-bece-3b5ba398fbfd', provider: 'moark', models: PROVIDER_LIMITS.moark.models, limits: { unitsPerDay: PROVIDER_LIMITS.moark.unitsPerDay } },
      { providerId: 'ab01e7b1-d71b-4719-90f0-47fcc89a120c', provider: 'cohere', models: PROVIDER_LIMITS.cohere.models, limits: { unitsPerDay: PROVIDER_LIMITS.cohere.unitsPerDay } },
      { providerId: '55be4301-c4e8-4108-af45-0e5c9b78e337', provider: 'cerebras', models: PROVIDER_LIMITS.cerebras.models, limits: { rpm: PROVIDER_LIMITS.cerebras.rpm } },
      { providerId: 'a5b4b6ff-cf1b-4d4d-b2e7-ec7e00328543', provider: 'ollama', models: PROVIDER_LIMITS.ollama.models, limits: { reqPerDay: 1000 } },  // 估计值
      { providerId: 'ab15cdcc-3028-4b67-973b-20a41f08e034', provider: 'mimo', models: PROVIDER_LIMITS.mimo.models, limits: { reqPerDay: 1000 } }   // 估计值
    ];

    providers.push(...fallbackProviders);

    return providers;
  }

  /**
   * 获取 Advisor 层的 provider 列表（按智力降级）
   * @returns {Promise<Array<{providerId, models}>>}
   */
  async getAdvisorProviders() {
    const advisorProviders = [];

    for (const tier of ADVISOR_MODELS) {
      // 查询 providerId（需要从 DB 获取，这里简化处理）
      // 实际应该通过 provider name 查询
      advisorProviders.push({
        providerId: tier.provider === 'claude' ? 'e0cdaf28-ae77-4db8-95bc-6b96d2fd144f' : (tier.provider === 'tkmyself-claude' ? '8338b4e4-98ec-4430-96d7-b8f704b74156' : '0468956f-5c64-4960-adff-56e48a819530'),
        models: tier.models
      });
    }

    return advisorProviders;
  }

  /**
   * 检查 provider key 是否在限流窗口内
   */
  async checkRateLimit(providerId, keyIndex = 0) {
    const key = `${providerId}:${keyIndex}`;
    const limit = 40; // 默认 40 req/min
    return await this.rateLimiter.checkAndIncrement(key, limit);
  }

  /**
   * 获取 provider 的限额信息
   */
  getProviderLimits(provider) {
    return PROVIDER_LIMITS[provider] || {};
  }
}

export { ProviderTiers, RateLimiter };

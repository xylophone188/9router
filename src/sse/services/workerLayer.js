/**
 * Worker Layer - 脏活累活杂活重活
 * NVIDIA 3-key blast + 免费供应商降级链
 * Redis 限流：每分钟每 key 40 次
 */

import { ProviderTiers } from './providerTiers.js';
import { getProviderConnections } from '@/lib/localDb.js';

class WorkerLayer {
  constructor(redis, db) {
    this.providerTiers = new ProviderTiers(redis);
    this.redis = redis;
    this.db = db;
  }

  /**
   * Worker 执行入口
   * @param {Object} params - 请求参数
   * @param {Array} params.messages - 对话消息
   * @param {Object} params.options - 选项
   * @returns {Promise<Object>} { response, provider, model, tier: 'worker'|'advisor'|'paid' }
   */
  async execute({ messages, options = {}, executeRequest }) {
    const { enableAdvisor = true } = options;

    // 1. 获取所有 Worker provider（按优先级）
    const workerProviders = await this.providerTiers.getWorkerProviders();

    // 2. 尝试每个 provider（支持 blast 并发）
    for (const provider of workerProviders) {
      // 检查限流
      const rateCheck = await this.providerTiers.checkRateLimit(provider.providerId, provider.keyIndex);
      if (!rateCheck.allowed) {
        console.warn('Worker provider rate limited', { providerId: provider.providerId, keyIndex: provider.keyIndex });
        continue;
      }

      // 尝试 blast 并发（前两个模型同时跑，取最快成功的）
      const result = await this.blastExecute(provider, messages, options, executeRequest);
      if (result) {
        return { ...result, tier: 'worker' };
      }
    }

    // 3. 所有 Worker 都失败，返回需要 paid fallback
    return { needsPaidFallback: true };
  }

  /**
   * Blast 并发执行：每个 key 并发前两个模型
   * 失败则尝试第三第四个
   */
  async blastExecute(provider, messages, options, executeRequest) {
    const models = provider.models;
    if (!models || models.length === 0) return null;

    // 第一轮：并发前两个模型
    const firstBatch = models.slice(0, 2);
    const secondBatch = models.slice(2, 4);

    for (const batch of [firstBatch, secondBatch]) {
      const promises = batch.map(model =>
        this.executeWithProvider(provider, model, messages, options, executeRequest)
          .then(r => ({ model, response: r, success: true }))
          .catch(err => ({ model, error: err, success: false }))
      );

      const results = await Promise.allSettled(promises);

      // 找第一个成功的
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.success) {
          console.log('Worker blast success', { provider: provider.provider, model: result.value.model });
          return {
            response: result.value.response,
            provider: provider.provider,
            model: result.value.model,
            providerId: provider.providerId
          };
        }
      }

      // 这一批全失败，记录错误，继续下一批
      const errors = results
        .filter(r => r.status === 'fulfilled' && !r.value.success)
        .map(r => r.value.error);
      console.warn('Worker blast batch failed', { provider: provider.provider, batch, errors });
    }

    return null;
  }

  /**
   * 单个 provider + model 执行
   */
  async executeWithProvider(provider, model, messages, options, executeRequest) {
    const connection = await this.db.getProviderConnection(provider.providerId);
    if (!connection || !connection.isActive) {
      throw new Error('Provider not active');
    }

    return await executeRequest({
      provider: provider.provider,
      model,
      messages,
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature || 0.7,
      stream: options.stream || false
    });
  }
}

export { WorkerLayer };

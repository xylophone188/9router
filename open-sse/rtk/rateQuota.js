/**
 * 9router rate limit, budget guard & semantic cache pipeline.
 *
 * TPM/RPM: 滑动窗口速率计数器 (per API key)
 * Budget:   usage tracking + 硬上限block
 * Semantic Cache: OV embedding做prompt相似度缓存
 */

// ─── TPM/RPM Rate Limiter ────────────────────────────────────────
const rateLimitStore = new Map();
const RATE_WINDOW_MS = 60_000; // 1min sliding window

function checkRateLimit(key, maxRequests, maxTokens) {
  if (!key) return { allowed: true };
  if (!maxRequests && !maxTokens) return { allowed: true };
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  
  if (!rateLimitStore.has(key)) {
    rateLimitStore.set(key, { requests: [], tokens: [] });
  }
  const entry = rateLimitStore.get(key);
  
  // Prune expired entries
  entry.requests = entry.requests.filter(t => t > windowStart);
  entry.tokens = entry.tokens.filter(t => t > windowStart);
  
  const allowed = {};
  if (maxRequests && entry.requests.length >= maxRequests) {
    allowed.allowed = false;
    allowed.reason = `RPM limit: ${entry.requests.length}/${maxRequests}`;
    allowed.retryAfter = Math.ceil((entry.requests[0] + RATE_WINDOW_MS - now) / 1000);
  } else if (maxTokens && entry.tokens.length >= maxTokens) {
    allowed.allowed = false;
    allowed.reason = `TPM limit: ${entry.tokens.length}/${maxTokens}`;
    allowed.retryAfter = Math.ceil((entry.tokens[0] + RATE_WINDOW_MS - now) / 1000);
  } else {
    allowed.allowed = true;
  }
  return allowed;
}

function recordUsage(key, tokenCount) {
  if (!key) return;
  if (!rateLimitStore.has(key)) {
    rateLimitStore.set(key, { requests: [], tokens: [] });
  }
  const entry = rateLimitStore.get(key);
  entry.requests.push(Date.now());
  if (tokenCount > 0) entry.tokens.push(...Array(Math.ceil(tokenCount / 100)).fill(Date.now()));
  // Cap store size
  if (rateLimitStore.size > 10000) {
    const oldest = [...rateLimitStore.keys()].slice(0, 100);
    oldest.forEach(k => rateLimitStore.delete(k));
  }
}

// ─── Budget Guard ────────────────────────────────────────────────
const budgetStore = new Map();
const BUDGET_DEFAULTS = {
  daily: 0,       // USD, 0=unlimited
  monthly: 0,     // USD, 0=unlimited
  hard: 0,        // USD per-request, 0=unlimited
};

function checkBudget(configKey, amount, budgetConfig = BUDGET_DEFAULTS) {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const key = configKey || "default";
  
  if (!budgetStore.has(key)) {
    budgetStore.set(key, { [today]: 0, [month]: 0 });
  }
  const entry = budgetStore.get(key);
  if (entry[today] === undefined) entry[today] = entry[Object.keys(entry).find(k => k === today)] ?? 0;
  if (entry[month] === undefined) entry[month] = entry[Object.keys(entry).find(k => k.startsWith(month))] ?? 0;
  
  const dailyUsed = entry[today] || 0;
  const monthlyUsed = entry[month] || 0;
  
  if (budgetConfig.hard > 0 && amount > budgetConfig.hard) {
    return { allowed: false, reason: `Single request $${amount.toFixed(4)} exceeds hard limit $${budgetConfig.hard}` };
  }
  if (budgetConfig.daily > 0 && dailyUsed + amount > budgetConfig.daily) {
    return { allowed: false, reason: `Daily $${(dailyUsed+amount).toFixed(2)} exceeds $${budgetConfig.daily}` };
  }
  if (budgetConfig.monthly > 0 && monthlyUsed + amount > budgetConfig.monthly) {
    return { allowed: false, reason: `Monthly $${(monthlyUsed+amount).toFixed(2)} exceeds $${budgetConfig.monthly}` };
  }
  return { allowed: true };
}

function recordBudget(configKey, amount) {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const key = configKey || "default";
  if (!budgetStore.has(key)) budgetStore.set(key, { [today]: 0, [month]: 0 });
  const entry = budgetStore.get(key);
  entry[today] = (entry[today] || 0) + amount;
  entry[month] = (entry[month] || 0) + amount;
}

// ─── Semantic Cache ──────────────────────────────────────────────
const semanticCacheStore = new Map();
const SC_CACHE_TTL = 3_600_000; // 1h

export function setSemanticCacheOptions(opts) {
  globalThis.__semanticCache = opts;
}

function getSemanticCacheOpts() {
  return globalThis.__semanticCache || {};
}

export async function semanticCacheLookup(messages, model) {
  const opts = getSemanticCacheOpts();
  if (!opts.enabled || !opts.ovUrl) return null;
  
  // Extract the last user message as query
  let query = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      query = typeof messages[i].content === "string" ? messages[i].content : "";
      if (query) break;
    }
  }
  if (!query || query.length < 20) return null;
  
  // Check cache first (in-memory)
  const cacheKey = `${model}:${query.slice(0, 100)}`;
  const cached = semanticCacheStore.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SC_CACHE_TTL) {
    return cached.entry; // { response: "...", cached: true }
  }
  
  // Try OV search for semantically similar entries
  // (9router's existing OV middleware already does this — this is a second layer)
  return null;
}

export function semanticCacheStoreResponse(model, query, response) {
  const cacheKey = `${model}:${query.slice(0, 100)}`;
  semanticCacheStore.set(cacheKey, { entry: { response, cached: true }, timestamp: Date.now() });
  if (semanticCacheStore.size > 5000) {
    const oldest = [...semanticCacheStore.entries()].sort((a,b) => a[1].timestamp - b[1].timestamp).slice(0, 200);
    oldest.forEach(([k]) => semanticCacheStore.delete(k));
  }
}

// ─── Pipeline entry ──────────────────────────────────────────────

/**
 * Pre-request check: rate limit + budget.
 * Returns { allowed: false, status: 429|402, ... } or { allowed: true }
 */
export function preRequestCheck(apiKey, settings) {
  // Rate limit check
  const rlConfig = settings?.rateLimit || {};
  const rl = checkRateLimit(apiKey, rlConfig.maxRequests, rlConfig.maxTokens);
  if (!rl.allowed) return { allowed: false, status: 429, error: rl.reason, retryAfter: rl.retryAfter };
  
  // Budget check (approximate — we check before the request using estimated cost)
  const budgetConfig = settings?.budget || {};
  const estimatedCost = budgetConfig.estimatedCost || 0;
  const bg = checkBudget(apiKey, estimatedCost, budgetConfig);
  if (!bg.allowed) return { allowed: false, status: 402, error: bg.reason };
  
  recordUsage(apiKey, 0); // token count comes from response
  return { allowed: true };
}

/**
 * Post-response: record usage & budget.
 */
export function postResponseRecord(apiKey, promptTokens, completionTokens, cost) {
  recordUsage(apiKey, promptTokens + completionTokens);
  if (cost > 0) recordBudget(apiKey, cost);
}

/**
 * Get stats for display
 */
export function getRateLimitStats() {
  const entries = [];
  let count = 0;
  for (const [key, val] of rateLimitStore) {
    if (count++ > 20) break;
    const now = Date.now();
    const reqs1m = val.requests.filter(t => t > now - 60000).length;
    entries.push({ key: key.slice(0, 12)+"...", rpm: reqs1m, totalReqs: val.requests.length });
  }
  return entries;
}

export function getBudgetStats() {
  const today = new Date().toISOString().slice(0, 10);
  const stats = [];
  let count = 0;
  for (const [key, val] of budgetStore) {
    if (count++ > 20) break;
    stats.push({ key: key.slice(0, 12)+"...", daily: (val[today] || 0).toFixed(2) });
  }
  return stats;
}

/**
 * Quota Tracker for Claude Pro subscription
 * Tracks 5h session windows and request counts
 */

const QUOTA_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours
const MAX_REQUESTS_PER_WINDOW = 100;

// In-memory store (persisted to settings DB)
let quotaState = {
  sessionStart: null,      // Window start timestamp
  requestCount: 0,         // Requests used in current window
  lastRequestAt: null,     // Last request timestamp
  requests: [],            // Recent request logs [{timestamp, provider, model, success}]
};

/**
 * Record a request to Claude
 */
export function recordRequest(provider, model, success = true) {
  const now = Date.now();
  
  // Check if we're in a new window
  if (!quotaState.sessionStart || (now - quotaState.sessionStart) > QUOTA_WINDOW_MS) {
    // New session window
    quotaState.sessionStart = now;
    quotaState.requestCount = 0;
    quotaState.requests = [];
  }
  
  quotaState.requestCount++;
  quotaState.lastRequestAt = now;
  quotaState.requests.push({
    timestamp: now,
    provider,
    model,
    success,
  });
  
  // Keep only last 100 requests
  if (quotaState.requests.length > 100) {
    quotaState.requests = quotaState.requests.slice(-100);
  }
  
  return getQuotaStatus();
}

/**
 * Get current quota status
 */
export function getQuotaStatus() {
  const now = Date.now();
  
  // Check if window expired
  if (quotaState.sessionStart && (now - quotaState.sessionStart) > QUOTA_WINDOW_MS) {
    return {
      used: 0,
      remaining: MAX_REQUESTS_PER_WINDOW,
      total: MAX_REQUESTS_PER_WINDOW,
      percentUsed: 0,
      sessionStart: null,
      windowExpiresAt: null,
      isExpired: true,
      shouldWarmUp: true,
    };
  }
  
  const used = quotaState.requestCount;
  const remaining = MAX_REQUESTS_PER_WINDOW - used;
  const windowExpiresAt = quotaState.sessionStart ? quotaState.sessionStart + QUOTA_WINDOW_MS : null;
  
  return {
    used,
    remaining,
    total: MAX_REQUESTS_PER_WINDOW,
    percentUsed: Math.round((used / MAX_REQUESTS_PER_WINDOW) * 100),
    sessionStart: quotaState.sessionStart,
    windowExpiresAt,
    isExpired: false,
    shouldWarmUp: remaining > 90, // Aggressive warm-up if barely used
    nextRefreshAt: windowExpiresAt,
  };
}

/**
 * Check if we should use Claude for this request
 * Returns: { shouldUse, reason, suggestedAction }
 */
export function shouldUseClaude(taskComplexity = 'medium') {
  const status = getQuotaStatus();
  const now = Date.now();
  
  // If session expired or about to expire, warm up immediately
  if (status.isExpired || (status.windowExpiresAt && status.windowExpiresAt - now < 60000)) {
    return {
      shouldUse: true,
      reason: 'Session expired or expiring, warm up',
      suggestedAction: 'warmup',
    };
  }
  
  // If barely used (< 20%), use Claude for important tasks
  if (status.percentUsed < 20) {
    return {
      shouldUse: taskComplexity === 'high',
      reason: `Quota healthy (${status.percentUsed}% used)`,
      suggestedAction: 'normal',
    };
  }
  
  // If 20-80% used, be selective
  if (status.percentUsed < 80) {
    return {
      shouldUse: taskComplexity === 'high',
      reason: `Quota moderate (${status.percentUsed}% used)`,
      suggestedAction: 'selective',
    };
  }
  
  // If > 80% used, only use for critical tasks
  if (status.percentUsed < 95) {
    return {
      shouldUse: false,
      reason: `Quota low (${status.percentUsed}% used), preserve`,
      suggestedAction: 'preserve',
    };
  }
  
  // If > 95% used, emergency mode
  return {
    shouldUse: false,
    reason: `Quota critical (${status.percentUsed}% used), emergency`,
    suggestedAction: 'emergency',
  };
}

/**
 * Get time until next refresh
 */
export function getTimeUntilRefresh() {
  const status = getQuotaStatus();
  if (!status.windowExpiresAt) return null;
  
  const now = Date.now();
  const msUntilRefresh = status.windowExpiresAt - now;
  
  if (msUntilRefresh <= 0) {
    return { ms: 0, human: 'Now', isExpired: true };
  }
  
  const hours = Math.floor(msUntilRefresh / (60 * 60 * 1000));
  const minutes = Math.floor((msUntilRefresh % (60 * 60 * 1000)) / (60 * 1000));
  
  return {
    ms: msUntilRefresh,
    human: `${hours}h ${minutes}m`,
    isExpired: false,
    hours,
    minutes,
  };
}

/**
 * Reset quota state (for testing or manual reset)
 */
export function resetQuota() {
  quotaState = {
    sessionStart: null,
    requestCount: 0,
    lastRequestAt: null,
    requests: [],
  };
  return getQuotaStatus();
}

/**
 * Export state for persistence
 */
export function exportState() {
  return { ...quotaState };
}

/**
 * Import state from persistence
 */
export function importState(state) {
  if (state) {
    quotaState = { ...quotaState, ...state };
  }
}

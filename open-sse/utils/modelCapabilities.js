/**
 * Model Capability Tracker
 * 
 * Tracks per-model capabilities (e.g., tool support) based on runtime behavior.
 * When a model returns 422 due to tool format incompatibility, it's marked as
 * not supporting tools. Future requests to that model will skip tools automatically.
 * 
 * Only affects the specific model, not the entire provider.
 */

// Map<modelKey, { tools: boolean, lastCheck: number }>
const capabilityCache = new Map();

// TTL: 1 hour (capabilities can change with model updates)
const CAPABILITY_TTL_MS = 60 * 60 * 1000;

/**
 * Generate a unique key for model capability tracking
 * @param {string} provider - Provider name (e.g., "mistral")
 * @param {string} model - Model name (e.g., "mistral-large-latest")
 * @returns {string}
 */
function modelKey(provider, model) {
  return `${provider}/${model}`;
}

/**
 * Check if a model is known to NOT support tools
 * @param {string} provider
 * @param {string} model
 * @returns {boolean} true if tools should be stripped
 */
export function shouldStripTools(provider, model) {
  const key = modelKey(provider, model);
  const cap = capabilityCache.get(key);
  if (!cap) return false; // Unknown = assume supports tools
  
  // Check TTL
  if (Date.now() - cap.lastCheck > CAPABILITY_TTL_MS) {
    capabilityCache.delete(key);
    return false;
  }
  
  return cap.tools === false;
}

/**
 * Mark a model as NOT supporting tools (called on tool-related 422)
 * @param {string} provider
 * @param {string} model
 */
export function markToolsUnsupported(provider, model) {
  const key = modelKey(provider, model);
  const existing = capabilityCache.get(key);
  
  // Don't overwrite if already marked and not expired
  if (existing && existing.tools === false && Date.now() - existing.lastCheck < CAPABILITY_TTL_MS) {
    return;
  }
  
  capabilityCache.set(key, {
    tools: false,
    lastCheck: Date.now(),
  });
  
  console.log(`[CAPABILITIES] Marked ${key} as tool-unsupported`);
}

/**
 * Mark a model as supporting tools (called on successful response with tools)
 * @param {string} provider
 * @param {string} model
 */
export function markToolsSupported(provider, model) {
  const key = modelKey(provider, model);
  capabilityCache.set(key, {
    tools: true,
    lastCheck: Date.now(),
  });
}

/**
 * Detect if a 422 error is tool-related by inspecting the error body
 * @param {string} errorBody - The parsed error message string
 * @returns {boolean}
 */
export function isToolRelated422(errorBody) {
  if (!errorBody || typeof errorBody !== "string") return false;
  
  // Mistral tool 422 patterns:
  // - "body","tools","list[union[...]]",N,"WebSearchTool","type"
  // - "body","tools","list[union[...]]",N,"Tool","function"
  // - '"extra_forbidden","loc":["body","tools"'
  // - '"literal_error","loc":["body","tools"'
  return (
    errorBody.includes('"body","tools"') ||
    errorBody.includes('"body",\'tools\'') ||
    errorBody.includes('"loc":["body","tools"') ||
    errorBody.includes("'tools','list[")
  );
}

/**
 * Get stats for debugging
 * @returns {Object}
 */
export function getCapabilityStats() {
  const stats = {};
  for (const [key, cap] of capabilityCache.entries()) {
    stats[key] = {
      tools: cap.tools,
      age: Math.round((Date.now() - cap.lastCheck) / 1000) + "s ago",
    };
  }
  return stats;
}

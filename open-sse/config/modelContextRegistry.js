/**
 * Model Context Registry — single source of truth for max context limits.
 *
 * Fields:
 *   maxInputCtx  — max input tokens (system + messages + tools + output headroom)
 *   maxOutputCtx — max output tokens the model can generate
 *   minInputCtx  — minimum valid input (1 token); models reject 0
 *
 * Usage:
 *   getModelCtxLimit(provider, model) → { maxInput, maxOutput }
 *   fitsContext(provider, model, estimatedTokens) → boolean
 *
 * Sources: official docs, verified 2026-06.
 * Unknown models → conservative default (32K input, 4K output)
 */

const DEFAULT_MAX_INPUT = 32_000;
const DEFAULT_MAX_OUTPUT = 4_096;

// ──────────────────────────────────────────────────────────────
// Registry: key = "provider/alias" or "provider/model-id"
// Alias: short form from providerModels.js (e.g. "cc/claude-opus-4-8")
// ──────────────────────────────────────────────────────────────

const CTX_REGISTRY = {
  // === Anthropic Claude ===
  "anthropic/claude-opus-4-20250514":      { maxInput: 200_000, maxOutput: 32_768 },
  "anthropic/claude-sonnet-4-20250514":    { maxInput: 200_000, maxOutput: 32_768 },
  "anthropic/claude-3-5-sonnet-20241022":  { maxInput: 200_000, maxOutput: 8_192 },
  "cc/claude-opus-4-8":     { maxInput: 200_000, maxOutput: 32_768 },
  "cc/claude-opus-4-7":     { maxInput: 200_000, maxOutput: 32_768 },
  "cc/claude-opus-4-6":     { maxInput: 200_000, maxOutput: 32_768 },
  "cc/claude-sonnet-4-6":   { maxInput: 200_000, maxOutput: 32_768 },
  "cc/claude-opus-4-5-20251101": { maxInput: 200_000, maxOutput: 32_768 },
  "cc/claude-sonnet-4-5-20250929": { maxInput: 200_000, maxOutput: 32_768 },
  "cc/claude-haiku-4-5-20251001": { maxInput: 200_000, maxOutput: 8_192 },

  // === OpenAI GPT ===
  "openai/gpt-5.4":          { maxInput: 128_000, maxOutput: 32_768 },
  "openai/gpt-5.4-mini":     { maxInput: 128_000, maxOutput: 32_768 },
  "openai/gpt-5.4-nano":     { maxInput: 128_000, maxOutput: 32_768 },
  "openai/gpt-5.2":          { maxInput: 128_000, maxOutput: 32_768 },
  "openai/gpt-5":            { maxInput: 128_000, maxOutput: 32_768 },
  "openai/gpt-5-mini":       { maxInput: 128_000, maxOutput: 32_768 },
  "openai/gpt-4o":           { maxInput: 128_000, maxOutput: 16_384 },
  "openai/gpt-4o-mini":      { maxInput: 128_000, maxOutput: 16_384 },
  "openai/gpt-4-turbo":      { maxInput: 128_000, maxOutput: 4_096 },
  "openai/gpt-4.1":          { maxInput: 128_000, maxOutput: 32_768 },
  "openai/gpt-4.1-mini":     { maxInput: 128_000, maxOutput: 32_768 },
  "openai/gpt-4.1-nano":     { maxInput: 128_000, maxOutput: 32_768 },
  // Reasoning
  "openai/o3":               { maxInput: 200_000, maxOutput: 100_000 },
  "openai/o3-mini":          { maxInput: 200_000, maxOutput: 100_000 },
  "openai/o3-pro":           { maxInput: 200_000, maxOutput: 100_000 },
  "openai/o4-mini":          { maxInput: 200_000, maxOutput: 100_000 },

  // === Gemini ===
  "gemini/gemini-2.5-pro":       { maxInput: 1_000_000, maxOutput: 65_536 },
  "gemini/gemini-2.5-flash":     { maxInput: 1_000_000, maxOutput: 65_536 },
  "gemini/gemini-3-flash-preview": { maxInput: 1_000_000, maxOutput: 65_536 },
  "gemini/gemini-3.1-pro-preview": { maxInput: 1_000_000, maxOutput: 65_536 },
  "gc/gemini-3-flash-preview":   { maxInput: 1_000_000, maxOutput: 65_536 },
  "gc/gemini-3-pro-preview":     { maxInput: 1_000_000, maxOutput: 65_536 },

  // === DeepSeek ===
  "deepseek/deepseek-v4-pro":    { maxInput: 163_840, maxOutput: 16_384 },
  "deepseek/deepseek-v4-flash":  { maxInput: 163_840, maxOutput: 16_384 },
  "deepseek/deepseek-chat":      { maxInput: 131_072, maxOutput: 8_192 },
  "deepseek/deepseek-reasoner":  { maxInput: 131_072, maxOutput: 8_192 },

  // === Mistral ===
  "mistral/mistral-large-latest":   { maxInput: 128_000, maxOutput: 32_768 },
  "mistral/mistral-medium-latest":  { maxInput: 128_000, maxOutput: 32_768 },
  "mistral/codestral-latest":       { maxInput: 32_000,  maxOutput: 16_384 },

  // === Qwen ===
  "if/qwen3-coder-plus":   { maxInput: 131_072, maxOutput: 16_384 },
  "if/qwen3-max":          { maxInput: 131_072, maxOutput: 16_384 },
  "if/qwen3-235b":         { maxInput: 131_072, maxOutput: 16_384 },
  "if/qwen3-32b":          { maxInput: 131_072, maxOutput: 16_384 },
  "if/deepseek-v3.2":      { maxInput: 131_072, maxOutput: 16_384 },
  "if/deepseek-v3.1":      { maxInput: 131_072, maxOutput: 16_384 },
  "if/kimi-k2":            { maxInput: 131_072, maxOutput: 16_384 },
  "if/glm-4.7":            { maxInput: 131_072, maxOutput: 16_384 },
  "qw/qwen3-coder-plus":   { maxInput: 131_072, maxOutput: 16_384 },

  // === Groq ===
  "groq/llama-3.3-70b-versatile":  { maxInput: 128_000, maxOutput: 32_768 },
  "groq/qwen/qwen3-32b":           { maxInput: 128_000, maxOutput: 32_768 },
  "groq/meta-llama/llama-4-maverick-17b-128e-instruct": { maxInput: 131_072, maxOutput: 32_768 },

  // === Kimi ===
  "kimi/kimi-k2.6":         { maxInput: 131_072, maxOutput: 16_384 },
  "kimi/kimi-k2.5":         { maxInput: 131_072, maxOutput: 16_384 },

  // === GLM ===
  "glm/glm-5.1":            { maxInput: 131_072, maxOutput: 16_384 },
  "glm/glm-5":              { maxInput: 131_072, maxOutput: 16_384 },

  // === MiMo ===
  "xiaomi-mimo/mimo-v2.5-pro": { maxInput: 131_072, maxOutput: 16_384 },
  "mmf/mimo-auto":             { maxInput: 131_072, maxOutput: 16_384 },

  // === xAI Grok ===
  "xai/grok-4":             { maxInput: 131_072, maxOutput: 32_768 },
  "xai/grok-3":             { maxInput: 131_072, maxOutput: 16_384 },

  // === Cerebras ===
  "cerebras/gpt-oss-120b":  { maxInput: 128_000, maxOutput: 32_768 },
  "cerebras/llama-3.3-70b": { maxInput: 128_000, maxOutput: 32_768 },

  // === MiniMax ===
  "minimax/MiniMax-M3":     { maxInput: 200_000, maxOutput: 16_384 },
  "minimax/MiniMax-M2.7":   { maxInput: 131_072, maxOutput: 16_384 },
  "minimax/MiniMax-M2.5":   { maxInput: 131_072, maxOutput: 16_384 },

  // === Together ===
  "together/meta-llama/Llama-3.3-70B-Instruct-Turbo": { maxInput: 128_000, maxOutput: 32_768 },
  "together/Qwen/Qwen3-235B-A22B":                     { maxInput: 131_072, maxOutput: 32_768 },

  // === NVIDIA NIM ===
  "nvidia/minimaxai/minimax-m2.7": { maxInput: 131_072, maxOutput: 16_384 },

  // === Blackbox ===
  "blackbox/claude-sonnet-4.6":  { maxInput: 200_000, maxOutput: 32_768 },
  "blackbox/claude-opus-4.6":    { maxInput: 200_000, maxOutput: 32_768 },
  "blackbox/gpt-4o":             { maxInput: 128_000, maxOutput: 16_384 },
  "blackbox/deepseek-chat":      { maxInput: 131_072, maxOutput: 8_192 },
  "blackbox/gemini-3-flash-preview": { maxInput: 1_000_000, maxOutput: 65_536 },

  // === SiliconFlow ===
  "siliconflow/deepseek-ai/DeepSeek-V4-Pro":  { maxInput: 163_840, maxOutput: 16_384 },
  "siliconflow/deepseek-ai/DeepSeek-V4-Flash": { maxInput: 163_840, maxOutput: 16_384 },
  "siliconflow/Qwen/Qwen3.5-397B-A17B":        { maxInput: 131_072, maxOutput: 32_768 },
  "siliconflow/zai-org/GLM-5.1":                { maxInput: 131_072, maxOutput: 16_384 },
  "siliconflow/moonshotai/Kimi-K2.6":           { maxInput: 131_072, maxOutput: 16_384 },

  // === CommandCode ===
  "commandcode/deepseek/deepseek-v4-pro":  { maxInput: 163_840, maxOutput: 16_384 },
  "commandcode/moonshotai/Kimi-K2.6":      { maxInput: 131_072, maxOutput: 16_384 },
  "commandcode/zai-org/GLM-5.1":           { maxInput: 131_072, maxOutput: 16_384 },
  "commandcode/Qwen/Qwen3.6-Plus":         { maxInput: 131_072, maxOutput: 16_384 },

  // === Volcengine ===
  "volcengine-ark/Doubao-Seed-2.0-Code":  { maxInput: 131_072, maxOutput: 16_384 },
  "volcengine-ark/DeepSeek-V4-Flash":     { maxInput: 163_840, maxOutput: 16_384 },
  "volcengine-ark/GLM-5.1":               { maxInput: 131_072, maxOutput: 16_384 },
  "volcengine-ark/Kimi-K2.6":             { maxInput: 131_072, maxOutput: 16_384 },

  // === Kiro ===
  "kr/claude-sonnet-4.5":  { maxInput: 200_000, maxOutput: 32_768 },
  "kr/claude-haiku-4.5":   { maxInput: 200_000, maxOutput: 8_192 },
  "kr/deepseek-3.2":       { maxInput: 131_072, maxOutput: 16_384 },
  "kr/qwen3-coder-next":   { maxInput: 131_072, maxOutput: 16_384 },
  "kr/glm-5":              { maxInput: 131_072, maxOutput: 16_384 },

  // === KiloCode (free) ===
  "kc/stepfun/step-3.7-flash:free":       { maxInput: 131_072, maxOutput: 16_384 },
  "kc/nvidia/nemotron-3-ultra-550b-a55b:free": { maxInput: 131_072, maxOutput: 32_768 },

  // === BytePlus ===
  "byteplus/seed-2-0-pro-260328":  { maxInput: 131_072, maxOutput: 16_384 },
  "byteplus/gpt-oss-120b-250805":  { maxInput: 131_072, maxOutput: 32_768 },

  // === Ollama (local) ===
  "ollama/gpt-oss:120b":     { maxInput: 131_072, maxOutput: 32_768 },
  "ollama/kimi-k2.5":         { maxInput: 131_072, maxOutput: 16_384 },
  "ollama/glm-5":             { maxInput: 131_072, maxOutput: 16_384 },

  // === Nous Research ===
  "nous-research/Hermes-4-405B": { maxInput: 131_072, maxOutput: 32_768 },
  "nous-research/Hermes-4-70B":  { maxInput: 131_072, maxOutput: 32_768 },

  // === Cloudflare Workers AI ===
  "cloudflare-ai/@cf/mistralai/mistral-small-3.1-24b-instruct": { maxInput: 32_000, maxOutput: 4_096 },
  "cloudflare-ai/@cf/meta/llama-3.1-70b-instruct-fp8-fast":    { maxInput: 128_000, maxOutput: 4_096 },
  "cloudflare-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast":     { maxInput: 128_000, maxOutput: 4_096 },

  // === Hyperbolic ===
  "hyperbolic/Qwen/QwQ-32B":              { maxInput: 131_072, maxOutput: 32_768 },
  "hyperbolic/deepseek-ai/DeepSeek-R1":    { maxInput: 131_072, maxOutput: 32_768 },
  "hyperbolic/meta-llama/Llama-3.3-70B-Instruct": { maxInput: 128_000, maxOutput: 32_768 },
};

/**
 * Resolve "provider/alias/model" or "provider/model" to registry key.
 * @param {string} provider - provider alias (cc, openai, gemini, etc.)
 * @param {string} model - model id (claude-opus-4-8, gpt-5.4, etc.)
 * @returns {string} registry key
 */
function resolveRegistryKey(provider, model) {
  // Try exact match: "provider/model"
  const exact = `${provider}/${model}`;
  if (CTX_REGISTRY[exact]) return exact;

  // Try alias lookup from PROVIDER_ID_TO_ALIAS
  // The providerModels.js maps e.g. "anthropic" → alias "cc", "openai" → "cx"
  // Try common aliases
  const ALIAS_MAP = {
    claude: "cc", codex: "cx", gemini: "gc", qwen: "qw",
    iflow: "if", antigravity: "ag", github: "gh", kiro: "kr",
    cursor: "cu", "kimi-coding": "kmc", kilocode: "kc", cline: "cl",
    opencode: "oc", "mimo-free": "mmf",
  };

  const alias = ALIAS_MAP[provider];
  if (alias) {
    const aliasKey = `${alias}/${model}`;
    if (CTX_REGISTRY[aliasKey]) return aliasKey;
  }

  return null;
}

/**
 * Get context limits for a provider/model.
 * @param {string} provider - provider alias
 * @param {string} model - model id
 * @returns {{ maxInput: number, maxOutput: number }}
 */
export function getModelCtxLimit(provider, model) {
  const key = resolveRegistryKey(provider, model);
  if (key) {
    return {
      maxInput: CTX_REGISTRY[key].maxInput,
      maxOutput: CTX_REGISTRY[key].maxOutput,
    };
  }
  // Fallback: try partial match (provider prefix)
  for (const [k, v] of Object.entries(CTX_REGISTRY)) {
    if (k.startsWith(`${provider}/`) && k.includes(model)) {
      return { maxInput: v.maxInput, maxOutput: v.maxOutput };
    }
  }
  return { maxInput: DEFAULT_MAX_INPUT, maxOutput: DEFAULT_MAX_OUTPUT };
}

/**
 * Check if a request fits within the model's context limit.
 * @param {string} provider - provider alias
 * @param {string} model - model id
 * @param {number} estimatedInputTokens - total input tokens
 * @returns {boolean}
 */
export function fitsContext(provider, model, estimatedInputTokens) {
  const { maxInput } = getModelCtxLimit(provider, model);
  // Leave 5% headroom for tokenizer variance
  return estimatedInputTokens <= maxInput * 0.95;
}

/**
 * Get context-aware truncation limit for a provider/model.
 * Returns maxInput minus headroom for output.
 * @param {string} provider
 * @param {string} model
 * @returns {number}
 */
export function getTruncationLimit(provider, model) {
  const { maxInput, maxOutput } = getModelCtxLimit(provider, model);
  // Reserve output space + 5% headroom
  const outputReserve = Math.min(maxOutput, 16_384);
  return Math.floor((maxInput - outputReserve) * 0.95);
}

/**
 * Get the full registry (for admin/debug).
 */
export function getRegistry() {
  return CTX_REGISTRY;
}

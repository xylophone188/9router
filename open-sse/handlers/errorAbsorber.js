/**
 * Error Absorber — cross-model fallback safety net
 *
 * When a single-model request fails (non-200), this module:
 * 1. Tries alternative models from the same provider
 * 2. Tries alternative models from related providers
 * 3. As last resort: synthesizes a 200 response with degradation notice
 *
 * Goal: Hermes NEVER sees non-200 from 9router.
 *
 * Usage: wrap handleSingleModelChat calls in the adapter path.
 */

import { getModelInfo, getComboModels } from "../../src/sse/services/model.js";
import { getProviderCredentials, markAccountUnavailable } from "../../src/sse/services/auth.js";
import { handleChatCore } from "./chatCore.js";
import { createErrorResult } from "../utils/error.js";

// ── Fallback model chains ────────────────────────────────────────────────
// Maps primary model aliases to fallback candidates.
// Order matters: try closest model first.
const FALLBACK_CHAINS = {
  // Mistral models
  "mistral/mistral-large-latest": [
    "mistral/mistral-medium-latest",
    "openai/gpt-5.4-mini",
    "anthropic/claude-sonnet-4-5",
  ],
  "mistral/mistral-medium-latest": [
    "mistral/mistral-large-latest",
    "openai/gpt-5.4-mini",
  ],
  // Anthropic models
  "anthropic/claude-sonnet-4-5": [
    "openai/gpt-5.4-mini",
    "mistral/mistral-large-latest",
  ],
  "anthropic/claude-opus-4-5": [
    "anthropic/claude-sonnet-4-5",
    "openai/gpt-5.4",
  ],
  // OpenAI models
  "openai/gpt-5.4": [
    "openai/gpt-5.4-mini",
    "anthropic/claude-sonnet-4-5",
  ],
  "openai/gpt-5.4-mini": [
    "openai/gpt-5.3-codex",
    "anthropic/claude-sonnet-4-5",
    "mistral/mistral-large-latest",
  ],
  // DeepSeek
  "deepseek/deepseek-chat": [
    "mistral/mistral-large-latest",
    "openai/gpt-5.4-mini",
  ],
};

// Generic fallback when model not in chains above
const GENERIC_FALLBACK = [
  "openai/gpt-5.4-mini",
  "mistral/mistral-large-latest",
  "anthropic/claude-sonnet-4-5",
];

/**
 * Get fallback candidates for a model.
 * Checks provider-specific chains first, then generic.
 */
function getFallbackCandidates(modelStr) {
  const chain = FALLBACK_CHAINS[modelStr];
  if (chain) return chain;
  // Try prefix match (e.g. "mistral/some-model" → same-provider fallback)
  const prefix = modelStr.split("/")[0];
  const sameProvider = Object.keys(FALLBACK_CHAINS)
    .filter(k => k.startsWith(prefix + "/") && k !== modelStr)
    .flatMap(k => FALLBACK_CHAINS[k]);
  if (sameProvider.length > 0) return sameProvider;
  return GENERIC_FALLBACK;
}

/**
 * Build a 200 success response with fallback content.
 * Used when ALL fallback models also fail — last resort.
 */
function buildDegradedResponse(originalModel, errorMsg) {
  return new Response(
    JSON.stringify({
      id: `chatcmpl-degraded-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: originalModel,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: `[Degraded] All fallback models failed. Original error: ${errorMsg}\n\nPlease try again in a moment.`,
          tool_calls: null,
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      _degraded: true,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "X-9router-Degraded": "true",
      },
    },
  );
}

/**
 * Try a single model request. Returns { success, response, error, status }.
 * On fallback (isFallback=true), strips tools to avoid format incompatibilities.
 */
async function tryModelRequest(body, modelStr, clientRawRequest, request, apiKey, signal, log, isFallback = false) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo?.provider) {
    return { success: false, error: `Unknown model: ${modelStr}`, status: 400 };
  }

  const { provider, model } = modelInfo;
  const credentials = await getProviderCredentials(provider, new Set(), model);
  if (!credentials || credentials.allRateLimited) {
    return { success: false, error: `No available credentials for ${provider}`, status: 503 };
  }

  // On fallback, strip tools to avoid format incompatibilities across providers
  const fallbackBody = isFallback ? { ...body } : body;
  if (isFallback && fallbackBody.tools) {
    delete fallbackBody.tools;
    delete fallbackBody.tool_choice;
  }

  try {
    const result = await handleChatCore({
      body: { ...fallbackBody, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent: request?.headers?.get("user-agent") || "",
      apiKey,
      ccFilterNaming: false,
      rtkEnabled: false,
      cavemanEnabled: false,
      signal,
    });

    if (result.success) {
      return { success: true, response: result.response };
    }

    // Mark account unavailable so next attempt uses a different one
    if (credentials.connectionId) {
      await markAccountUnavailable(
        credentials.connectionId,
        result.status,
        result.error,
        provider,
        model,
        result.resetsAtMs,
      ).catch(() => {});
    }

    return { success: false, error: result.error, status: result.status };
  } catch (err) {
    return {
      success: false,
      error: err.message || String(err),
      status: err.name === "AbortError" ? 499 : 502,
    };
  }
}

/**
 * Error absorber: wrap a failed single-model request with cross-model fallback.
 *
 * @param {object} options
 * @param {object} options.body - Original request body
 * @param {string} options.failedModel - The model that just failed
 * @param {string} options.errorMsg - Error message from the failure
 * @param {number} options.errorStatus - HTTP status from the failure
 * @param {Request} options.request - Original HTTP request
 * @param {string} options.apiKey - API key
 * @param {AbortSignal} options.signal - Abort signal
 * @param {object} options.log - Logger
 * @returns {Response} Always returns an HTTP Response (200 or degraded 200)
 */
export async function absorbError({
  body,
  failedModel,
  errorMsg,
  errorStatus,
  request,
  apiKey,
  signal,
  log,
}) {
  const candidates = getFallbackCandidates(failedModel);

  // Filter out the failed model itself
  const toTry = candidates.filter(m => m !== failedModel);

  if (toTry.length === 0) {
    log?.warn?.("ABSORB", `No fallback candidates for ${failedModel}, synthesizing degraded response`);
    return buildDegradedResponse(failedModel, errorMsg);
  }

  log?.info?.("ABSORB", `${failedModel} failed (${errorStatus}: ${errorMsg}), trying ${toTry.length} fallback(s): ${toTry.join(", ")}`);

  for (const candidate of toTry) {
    log?.info?.("ABSORB", `Trying fallback: ${candidate}`);
    const result = await tryModelRequest(body, candidate, null, request, apiKey, signal, log, true);

    if (result.success) {
      log?.info?.("ABSORB", `Fallback ${candidate} succeeded`);
      return result.response;
    }

    log?.warn?.("ABSORB", `Fallback ${candidate} also failed: ${result.error}`);
  }

  // All fallbacks failed — synthesize degraded 200
  log?.warn?.("ABSORB", `All fallbacks exhausted for ${failedModel}, synthesizing degraded response`);
  return buildDegradedResponse(failedModel, errorMsg);
}

/**
 * Check if a response is an error that should trigger fallback.
 * Returns true for 4xx/5xx responses.
 */
export function isErrorThatShouldFallback(status) {
  // 4xx (except 401 which is handled by token refresh)
  if (status >= 400 && status < 500 && status !== 401) return true;
  // 5xx
  if (status >= 500) return true;
  return false;
}

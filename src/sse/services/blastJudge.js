/**
 * Blast Judge Service
 * Sends top N blast results to Claude for quality judging
 */

import { getProviderCredentials, checkAndRefreshToken } from "./auth.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { recordRequest } from "./quotaTracker.js";
import { getSettings } from "@/lib/localDb.js";

/**
 * Judge blast results using Claude
 * @param {Object} params
 * @param {Object} params.originalBody - Original request body
 * @param {Array} params.candidates - [{model, response, connectionName}]
 * @param {string} params.judgeProvider - Provider for judging (e.g., "anthropic")
 * @param {string} params.judgeModel - Model for judging (e.g., "claude-sonnet-4-20250514")
 * @param {Object} params.settings - Settings object
 * @param {Object} params.log - Logger
 * @returns {Response} The winning response
 */
export async function judgeBlastResults({ originalBody, candidates, judgeProvider, judgeModel, settings, log }) {
  const currentSettings = settings || await getSettings();
  if (currentSettings.localFeaturesEnabled === false) {
    return candidates?.[0]?.response || errorResponse(HTTP_STATUS.INTERNAL_SERVER_ERROR, "Blast judge disabled");
  }

  if (!candidates || candidates.length === 0) {
    return errorResponse(HTTP_STATUS.INTERNAL_SERVER_ERROR, "No candidates to judge");
  }

  // If only 1 candidate, return it directly (no judging needed)
  if (candidates.length === 1) {
    log.info("CHAT", `Blast judge: only 1 candidate (${candidates[0].model}), returning directly`);
    return candidates[0].response;
  }

  // Build judge prompt
  const originalPrompt = originalBody.messages?.map(m => `${m.role}: ${m.content}`).join("\n") || JSON.stringify(originalBody);
  
  const candidateTexts = candidates.map((c, i) => {
    // Extract text content from response
    let content = "";
    if (c.response?.body) {
      // Handle both streaming and non-streaming responses
      if (typeof c.response.body === "string") {
        content = c.response.body;
      } else if (c.response.body?.getReader) {
        // Streaming response - we already consumed it, content should be in the original response
        content = "[streaming response]";
      }
    }
    // Try to extract from response text if available
    if (!content && c.response?.text) {
      content = c.response.text;
    }
    return `--- Candidate ${i + 1} (${c.model}) ---\n${content || "[no content]"}`;
  }).join("\n\n");

  const judgePrompt = `You are a response quality judge. Compare these ${candidates.length} candidate responses to the user's original request and select the BEST one.

Original Request:
${originalPrompt}

Candidates:
${candidateTexts}

Reply with ONLY a JSON object in this exact format:
{"winner": <1-based index of best candidate>, "reason": "<brief reason>"}

Do NOT include any other text. Just the JSON.`;

  // Get judge provider credentials
  const judgeCredentials = await getProviderCredentials(judgeProvider, new Set(), judgeModel);
  if (!judgeCredentials) {
    log.warn("CHAT", `Blast judge: no credentials for ${judgeProvider}, returning first candidate`);
    return candidates[0].response;
  }

  const refreshedJudgeCredentials = await checkAndRefreshToken(judgeProvider, judgeCredentials);
  const userAgent = "9router-blast-judge/1.0";

  log.info("CHAT", `Blast judge: sending ${candidates.length} candidates to ${judgeProvider}/${judgeModel}`);

  // Call judge model (non-streaming)
  const judgeBody = {
    model: `${judgeProvider}/${judgeModel}`,
    messages: [{ role: "user", content: judgePrompt }],
    stream: false,
    max_tokens: 200,
  };

  const judgeResult = await handleChatCore({
    body: judgeBody,
    modelInfo: { provider: judgeProvider, model: judgeModel },
    credentials: refreshedJudgeCredentials,
    log,
    clientRawRequest: null,
    connectionId: judgeCredentials.connectionId,
    userAgent,
    apiKey: null,
    ccFilterNaming: false,
    rtkEnabled: false,
    cavemanEnabled: false,
    cavemanLevel: "full",
    signal: null,
    providerThinking: null,
    sourceFormatOverride: null,
    onCredentialsRefreshed: null,
    onRequestSuccess: null,
  });

  // Record the judge request for quota tracking
  recordRequest(judgeProvider, judgeModel, judgeResult.success);

  if (!judgeResult.success) {
    log.warn("CHAT", `Blast judge failed: ${judgeResult.error}, returning first candidate`);
    return candidates[0].response;
  }

  // Parse judge response
  try {
    let judgeText = "";
    if (judgeResult.response?.body) {
      // Extract text from response body
      if (typeof judgeResult.response.body === "string") {
        judgeText = judgeResult.response.body;
      } else if (judgeResult.response.body?.text) {
        judgeText = judgeResult.response.body.text;
      }
    }
    if (!judgeText && judgeResult.response?.text) {
      judgeText = judgeResult.response.text;
    }

    // Try to extract JSON from response
    const jsonMatch = judgeText.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const judgeDecision = JSON.parse(jsonMatch[0]);
      const winnerIndex = (judgeDecision.winner || 1) - 1; // Convert to 0-based
      
      if (winnerIndex >= 0 && winnerIndex < candidates.length) {
        log.info("CHAT", `Blast judge winner: ${candidates[winnerIndex].model} (index ${winnerIndex + 1}) - ${judgeDecision.reason}`);
        return candidates[winnerIndex].response;
      }
    }
  } catch (e) {
    log.warn("CHAT", `Blast judge parse failed: ${e.message}`);
  }

  // Fallback: return first candidate
  log.info("CHAT", "Blast judge: parse failed, returning first candidate");
  return candidates[0].response;
}

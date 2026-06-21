/**
 * Context truncation — drop oldest messages when total input exceeds model limit.
 * Runs AFTER compressMessages (RTK) and BEFORE executor.
 *
 * Strategy:
 *  1. Keep system message(s) always
 *  2. Keep first user message (anchor/context)
 *  3. Keep most recent messages up to budget
 *  4. Drop middle messages, add a truncation marker
 */

// Conservative char→token estimate (covers multilingual)
const CHARS_PER_TOKEN = 4;

const TRUNCATION_MARKER =
  "[Context truncated by 9router — older messages removed to fit model limit]";

/**
 * Rough token estimate for a single message object.
 * Handles string content, array content, tool messages, etc.
 */
function estimateTokens(obj) {
  if (!obj) return 0;
  let chars = 0;
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === "string") { chars += v.length; return; }
    if (typeof v === "number" || typeof v === "boolean") { chars += 12; return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === "object") {
      for (const k of Object.keys(v)) {
        if (k === "type" || k === "role") { chars += 4; continue; }
        walk(v[k]);
      }
    }
  };
  walk(obj);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Estimate total tokens for an array of messages.
 */
function estimateTotalTokens(messages) {
  let total = 0;
  for (const m of messages) total += estimateTokens(m);
  return total;
}

/**
 * Truncate messages to fit within token budget.
 * @param {Array} messages - mutable message array
 * @param {number} maxTokens - target token limit (use model's limit minus headroom)
 * @param {object} [log] - logger
 * @returns {{ truncated: boolean, tokensBefore: number, tokensAfter: number, dropped: number }}
 */
export function truncateMessages(messages, maxTokens, log) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { truncated: false, tokensBefore: 0, tokensAfter: 0, dropped: 0 };
  }

  const tokensBefore = estimateTotalTokens(messages);
  if (tokensBefore <= maxTokens) {
    return { truncated: false, tokensBefore, tokensAfter: tokensBefore, dropped: 0 };
  }

  // Separate system messages from conversation
  const systemMsgs = [];
  const convoMsgs = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemMsgs.push(m);
    } else {
      convoMsgs.push(m);
    }
  }

  const systemTokens = estimateTotalTokens(systemMsgs);
  const budget = maxTokens - systemTokens;

  if (budget <= 0) {
    // System messages alone exceed budget — truncate last system message
    log?.warn?.("TRUNCATE", `System messages alone (${systemTokens}t) exceed budget (${maxTokens}t), keeping only first system`);
    systemMsgs.length = 1;
    return {
      truncated: true,
      tokensBefore,
      tokensAfter: estimateTokens(systemMsgs[0]),
      dropped: messages.length - 1,
    };
  }

  // Strategy: keep first user msg (anchor) + recent messages
  // Find first user message index in convoMsgs
  const firstUserIdx = convoMsgs.findIndex((m) => m.role === "user");
  const anchorMsg = firstUserIdx >= 0 ? [convoMsgs[firstUserIdx]] : [];
  const anchorTokens = estimateTotalTokens(anchorMsg);

  // Remaining budget for recent messages
  const recentBudget = budget - anchorTokens;
  if (recentBudget <= 0) {
    // Anchor alone fills budget — keep only anchor + system
    log?.warn?.("TRUNCATE", `First user msg (${anchorTokens}t) exceeds remaining budget, keeping only anchor`);
    messages.length = 0;
    messages.push(...systemMsgs, ...anchorMsg);
    return {
      truncated: true,
      tokensBefore,
      tokensAfter: estimateTokens(messages),
      dropped: convoMsgs.length - 1,
    };
  }

  // Walk backwards from end, accumulate recent messages up to budget
  const recentMsgs = [];
  let recentTokens = 0;
  for (let i = convoMsgs.length - 1; i >= 0; i--) {
    // Skip the anchor msg (we already counted it)
    if (i === firstUserIdx) continue;
    const msgTokens = estimateTokens(convoMsgs[i]);
    if (recentTokens + msgTokens > recentBudget) break;
    recentMsgs.unshift(convoMsgs[i]);
    recentTokens += msgTokens;
  }

  // Count dropped messages (between anchor and recent)
  const anchorIdx = firstUserIdx >= 0 ? firstUserIdx : -1;
  const recentStartIdx = anchorIdx >= 0
    ? convoMsgs.indexOf(recentMsgs[0])
    : convoMsgs.length - recentMsgs.length;
  const droppedCount = Math.max(0, recentStartIdx - (anchorIdx >= 0 ? anchorIdx + 1 : 0));

  // Reassemble
  messages.length = 0;
  messages.push(...systemMsgs);

  if (anchorMsg.length > 0) {
    messages.push(...anchorMsg);
  }

  if (droppedCount > 0) {
    // Insert truncation marker as a system note
    messages.push({ role: "system", content: TRUNCATION_MARKER });
  }

  messages.push(...recentMsgs);

  const tokensAfter = estimateTotalTokens(messages);

  log?.info?.(
    "TRUNCATE",
    `Context truncated: ${tokensBefore}t → ${tokensAfter}t (${droppedCount} msgs dropped, budget=${maxTokens}t)`
  );

  return {
    truncated: true,
    tokensBefore,
    tokensAfter,
    dropped: droppedCount,
  };
}

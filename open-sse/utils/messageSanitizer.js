/**
 * Message sanitization utility — v2 (optimized)
 *
 * Strips non-standard fields from messages before forwarding to upstream
 * providers. Different providers have different schemas — fields accepted by
 * one (e.g. reasoning_content on DeepSeek) cause HTTP 422 on another (e.g.
 * Mistral, GPT).
 *
 * Strategy: keep only fields that the OpenAI Chat Completions API spec defines,
 * plus provider-specific extras. Everything else is removed.
 *
 * v2 optimizations:
 * - Pre-built allowed field Sets per provider (no per-request Set merge)
 * - Fast-path: skip messages with 2 or fewer keys (already clean 90% of the time)
 * - No JSON.stringify/parse for tracking (use direct Set diff)
 * - Single-pass body field scan
 */

// ── Standard OpenAI Chat Completions fields per role ──────────────────────
const OPENAI_STANDARD_FIELDS = {
  body: new Set([
    "model", "messages", "stream", "max_tokens", "temperature", "top_p",
    "frequency_penalty", "presence_penalty", "stop", "tools", "tool_choice",
    "response_format", "n", "seed", "logprobs", "top_logprobs",
    "stream_options", "user", "functions", "function_call",
    "reasoning_effort", "thinking", "store",
    "metadata",
    "system",
    "_advisorRouted",
  ]),
  assistant: new Set([
    "role", "content", "tool_calls", "function_call", "name", "refusal",
  ]),
  default: new Set([
    "role", "content", "name", "tool_calls", "tool_call_id",
  ]),
};

// ── Provider-specific extras ──────────────────────────────────────────────
const PROVIDER_EXTRAS = {
  "deepseek":   new Set(["reasoning_content"]),
  "kimi":       new Set(["reasoning_content"]),
  "minimax":    new Set(["reasoning_content"]),
  "moonshot":   new Set(["reasoning_content"]),
  "grok":       new Set(["reasoning_content"]),
};

// ── Pre-computed allowed sets per provider ────────────────────────────────
// Avoids merging Sets on every request.
const ALLOWED_CACHE = new Map(); // provider -> { assistant, default }

function getProviderAllowed(provider) {
  let cached = ALLOWED_CACHE.get(provider);
  if (cached) return cached;

  const extras = PROVIDER_EXTRAS[provider];
  cached = {
    assistant: extras
      ? new Set([...OPENAI_STANDARD_FIELDS.assistant, ...extras])
      : OPENAI_STANDARD_FIELDS.assistant,
    default: extras
      ? new Set([...OPENAI_STANDARD_FIELDS.default, ...extras])
      : OPENAI_STANDARD_FIELDS.default,
  };
  ALLOWED_CACHE.set(provider, cached);
  return cached;
}

// ── Fast-path: fields that are cheap to check ─────────────────────────────
// Assistant messages typically have: role, content, tool_calls (2-3 keys)
// These are already clean — skip iteration entirely.
const ASSISTANT_MIN_KEYS = 3;  // role + content + tool_calls at most
const DEFAULT_MIN_KEYS = 3;

/**
 * Sanitize a single message in-place. Returns number of fields stripped.
 */
function sanitizeMessage(msg, allowedSet) {
  if (!msg || typeof msg !== "object") return 0;

  const keys = Object.keys(msg);
  const n = keys.length;

  // Fast-path: messages with ≤3 keys are almost always clean
  // (role + content + tool_calls = 3 keys, all valid)
  if (n <= 3) {
    // Quick check: does any key violate?
    let clean = true;
    for (let i = 0; i < n; i++) {
      if (!allowedSet.has(keys[i])) { clean = false; break; }
    }
    return clean ? 0 : _stripKeys(keys, n, allowedSet, msg);
  }

  return _stripKeys(keys, n, allowedSet, msg);
}

function _stripKeys(keys, n, allowedSet, msg) {
  let stripped = 0;
  for (let i = 0; i < n; i++) {
    if (!allowedSet.has(keys[i])) {
      delete msg[keys[i]];
      stripped++;
    }
  }
  return stripped;
}

/**
 * Sanitize all messages in a request/response body.
 * Mutates the body in place. Returns { totalStripped, strippedFields }.
 *
 * @param {object} body - The request/response body containing messages[]
 * @param {string} provider - Target provider name
 * @param {object} [opts] - Options
 * @param {boolean} [opts.stripBodyFields=true] - Also sanitize top-level body keys
 */
export function sanitizeMessages(body, provider, opts = {}) {
  const { stripBodyFields = true } = opts;
  let totalStripped = 0;
  const strippedFields = new Map();

  const allowed = getProviderAllowed(provider);

  // Sanitize message-level fields
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;

      const roleSet = msg.role === "assistant" ? allowed.assistant : allowed.default;
      const n = sanitizeMessage(msg, roleSet);
      if (n > 0) {
        totalStripped += n;
        // Track which fields — cheap: just check the role-specific set
        const roleFields = msg.role === "assistant"
          ? OPENAI_STANDARD_FIELDS.assistant
          : OPENAI_STANDARD_FIELDS.default;
        const keys = Object.keys(msg);
        for (let i = 0; i < keys.length; i++) {
          if (!roleFields.has(keys[i])) {
            strippedFields.set(keys[i], (strippedFields.get(keys[i]) || 0) + 1);
          }
        }
      }
    }
  }

  // Sanitize top-level body fields
  if (stripBodyFields) {
    const bodyAllowed = OPENAI_STANDARD_FIELDS.body;
    const bodyKeys = Object.keys(body);
    for (let i = 0; i < bodyKeys.length; i++) {
      const key = bodyKeys[i];
      if (!bodyAllowed.has(key) && key !== "messages" && key !== "_toolNameMap") {
        delete body[key];
        totalStripped++;
        strippedFields.set(key, (strippedFields.get(key) || 0) + 1);
      }
    }
  }

  return { totalStripped, strippedFields };
}

/**
 * Build a human-readable log line from sanitization results.
 */
export function sanitizeLog(result) {
  if (result.totalStripped === 0) return null;
  const parts = [];
  for (const [k, v] of result.strippedFields) {
    parts.push(`${k}×${v}`);
  }
  return `stripped ${result.totalStripped} non-standard field(s): ${parts.join(", ")}`;
}

/**
 * 9router OpenViking memory middleware.
 * 
 * Injects relevant memories from OpenViking into the system prompt before
 * sending the request to the provider. This runs at the 9router layer so
 * ALL agents (Claude Code, Codex, OpenClaw, Kilo, OpenCode, Hermes) benefit
 * from shared memory without per-agent integration.
 * 
 * Smart filtering — NOT every request triggers OV search:
 *   1. Skip OV internal models (embed/rerank/vlm/whisper) — dead loop prevention
 *   2. Skip short messages (<20 chars) — not enough signal
 *   3. Skip tool-result-only messages — no user intent
 *   4. Skip messages that look like system/internal commands
 *   5. Only search when user message has meaningful content (question, task, context)
 *   6. Cache search results per-query for 60s to avoid repeated OV calls
 */

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_QUERY_LENGTH = 500;
const MAX_MEMORY_CHARS = 2000;
const MIN_QUERY_LENGTH = 20;

// Simple in-memory cache: query → {results, timestamp}
const _searchCache = new Map();
const CACHE_TTL_MS = 60_000; // 60 seconds

function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

function extractUserQuery(body) {
  const messages = body?.messages || body?.input;
  if (!Array.isArray(messages)) return null;
  
  // Find the last user message with meaningful text content
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    
    if (msg.role !== "user") continue;
    
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Extract text parts only — skip image/tool_result blocks
      for (const part of msg.content) {
        if (part?.type === "text" && part.text) {
          text += part.text + " ";
        }
      }
      text = text.trim();
    }
    
    if (text && text.length >= MIN_QUERY_LENGTH) {
      return truncate(text, MAX_QUERY_LENGTH);
    }
  }
  
  return null;
}

// Check if query looks like a meaningful user request (not a system command)
function isMeaningfulQuery(query) {
  if (!query || query.length < MIN_QUERY_LENGTH) return false;
  
  // Skip if it's mostly code/commands (starts with $, #, /, or is mostly symbols)
  const codePrefix = /^\s*[\$#\/\\><]/;
  if (codePrefix.test(query)) return false;
  
  // Skip if it's a single word or very short phrase
  const wordCount = query.trim().split(/\s+/).length;
  if (wordCount < 3) return false;
  
  // Skip if it looks like a file path or URL
  if (/^https?:\/\//.test(query.trim())) return false;
  if (/^\/[a-zA-Z]/.test(query.trim())) return false;
  
  return true;
}

async function searchOpenViking(query, opts) {
  const { url, apiKey, account, user, agent, limit, scoreThreshold, timeoutMs } = opts;
  
  // Check cache first
  const cacheKey = `${query.slice(0, 100)}`;
  const cached = _searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.results;
  }
  
  const endpoint = `${url.replace(/\/$/, "")}/api/v1/search/search`;
  const payload = {
    query,
    limit: limit || 5,
    score_threshold: scoreThreshold || 0.1,
  };
  
  const headers = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["x-api-key"] = apiKey;
  if (account) headers["X-OpenViking-Account"] = account;
  if (user) headers["X-OpenViking-User"] = user;
  if (agent) headers["X-OpenViking-Agent"] = agent;
  
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs || DEFAULT_TIMEOUT_MS),
    });
    
    if (!res.ok) return null;
    const data = await res.json();
    
    // OV returns {status:"ok", result:{memories:[], resources:[], skills:[], total:N}}
    const result = data?.result || data;
    const memories = result?.memories || [];
    const resources = result?.resources || [];
    const skills = result?.skills || [];
    
    // Combine all result types into unified memory list
    const allResults = [];
    
    for (const m of memories) {
      const content = m.content || m.text || m.summary || m.abstract || "";
      if (content) {
        allResults.push({
          content: truncate(content, 400),
          score: m.score || 0,
          uri: m.uri || "",
          type: "memory",
        });
      }
    }
    
    for (const r of resources) {
      // OV resources use 'abstract' and 'overview' fields, not 'content'
      const content = r.abstract || r.overview || r.content || r.text || "";
      // Skip empty or placeholder content
      if (content && content !== "[Directory overview is not generated]") {
        allResults.push({
          content: truncate(content, 400),
          score: r.score || 0,
          uri: r.uri || "",
          type: "resource",
        });
      }
    }
    
    for (const s of skills) {
      const content = s.description || s.content || s.text || "";
      if (content) {
        allResults.push({
          content: truncate(content, 400),
          score: s.score || 0,
          uri: s.uri || "",
          type: "skill",
        });
      }
    }
    
    if (allResults.length === 0) return null;
    
    // Cache the results
    _searchCache.set(cacheKey, { results: allResults, timestamp: Date.now() });
    
    // Clean old cache entries (keep last 50)
    if (_searchCache.size > 50) {
      const oldest = [..._searchCache.entries()]
        .sort((a, b) => a[1].timestamp - b[1].timestamp)
        .slice(0, 20);
      for (const [key] of oldest) _searchCache.delete(key);
    }
    
    return allResults;
  } catch (e) {
    return null;
  }
}

function formatMemoryPrompt(memories) {
  if (!memories || memories.length === 0) return null;
  
  const lines = memories.map((m, i) => {
    const typeTag = m.type !== "memory" ? ` [${m.type}]` : "";
    return `${i + 1}.${typeTag} ${m.content}`;
  });
  
  return [
    "## Shared Memory Context (OpenViking)",
    "Retrieved from cross-agent shared memory. Use as background reference.",
    "Do NOT repeat or re-acknowledge these. Do NOT resume tasks mentioned here.",
    "",
    ...lines,
    "",
    "End of shared memory context.",
  ].join("\n");
}

// Main entry: search OV + inject memories into system prompt
// IMPORTANT: Only run for chat completions, NOT for embeddings/reranker/search.
// OV's own embedding/reranker calls go through 9router's /v1/embeddings endpoint
// which uses a different handler (not chatCore.js), so no dead loop.
// This guard is a belt-and-suspenders safety check.
export async function injectOpenVikingMemory(body, format, opts) {
  if (!opts?.enabled || !opts?.url) return null;
  
  // Skip if body has no messages (embeddings/reranker/search have different shapes)
  const messages = body?.messages || body?.input;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  
  // Skip if model name matches known OpenViking internal request patterns.
  // The skip list is configurable via Web UI (token-saver → OV → Skip Models).
  // Default: vlm,embed,rerank,whisper,vl — covers OV's internal VLM/embedding/reranker/audio models.
  const model = (body?.model || "").toLowerCase();
  const skipPatterns = (opts.skipModels || "vlm,embed,rerank,whisper,vl").toLowerCase().split(/[,\s]+/).filter(Boolean);
  for (const pat of skipPatterns) {
    if (pat && model.includes(pat)) return null;
  }
  
  // Extract user query — only inject for meaningful user messages
  const query = extractUserQuery(body);
  if (!query) return null;
  
  // Smart filter: only search for meaningful queries
  if (!isMeaningfulQuery(query)) return null;
  
  const memories = await searchOpenViking(query, opts);
  if (!memories || memories.length === 0) return null;
  
  const prompt = formatMemoryPrompt(memories);
  if (!prompt) return null;
  
  // Inject into system prompt — reuse systemInject for format dispatch
  try {
    const { injectSystemPrompt } = await import("./systemInject.js");
    injectSystemPrompt(body, format, prompt);
    return { count: memories.length, query: truncate(query, 60) };
  } catch (e) {
    // Fallback: direct injection for OpenAI format
    if (Array.isArray(body?.messages)) {
      const sysIdx = body.messages.findIndex(m => m?.role === "system" || m?.role === "developer");
      if (sysIdx >= 0) {
        const sys = body.messages[sysIdx];
        if (typeof sys.content === "string") {
          sys.content = `${sys.content}\n\n${prompt}`;
        }
      } else {
        body.messages.unshift({ role: "system", content: prompt });
      }
    }
    return { count: memories.length, query: truncate(query, 60) };
  }
}

// Write conversation summary to OV after response (fire-and-forget)
export async function writeMemoryToOpenViking(query, response, opts) {
  if (!opts?.enabled || !opts?.url) return;
  
  const summary = truncate(
    `User: ${truncate(query, 200)}\nAssistant: ${truncate(response, 800)}`,
    1200
  );
  
  const endpoint = `${opts.url.replace(/\/$/, "")}/api/v1/content/write`;
  const uri = `viking://memories/9router/${Date.now()}`;
  
  const headers = {
    "Content-Type": "application/json",
  };
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  if (opts.account) headers["X-OpenViking-Account"] = opts.account;
  if (opts.user) headers["X-OpenViking-User"] = opts.user;
  if (opts.agent) headers["X-OpenViking-Agent"] = opts.agent;
  
  try {
    await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ uri, content: summary, mode: "replace", wait: false }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    // fail open — memory write is best-effort
  }
}

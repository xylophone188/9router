/**
 * Rerank handler — proxies rerank requests to the configured provider.
 * Uses gitee Qwen3-Reranker-8B as default rerank backend.
 */
import { getSettings } from "@/lib/localDb";
import { extractApiKey, isValidApiKey } from "../services/auth.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";

// Gitee rerank config
const GITEE_RERANK_URL = "https://ai.gitee.com/v1/rerank";
const GITEE_RERANK_MODEL = "Qwen3-Reranker-8B";

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: { message, type: "server_error", code: status } }), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

export async function handleRerank(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  log.request("POST", url.pathname);

  // Auth check
  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  // Validate required fields
  if (!body.query) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: query");
  if (!body.documents || !Array.isArray(body.documents) || body.documents.length === 0) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: documents (non-empty array)");
  }

  // Resolve API key from provider-node or use default gitee key
  const providerApiKey = await resolveRerankApiKey();
  if (!providerApiKey) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "No rerank API key configured");
  }

  // Build upstream request
  const upstreamBody = {
    model: body.model || GITEE_RERANK_MODEL,
    query: body.query,
    documents: body.documents,
    top_n: body.top_n || body.documents.length,
  };
  if (body.max_chunks_per_document !== undefined) {
    upstreamBody.max_chunks_per_document = body.max_chunks_per_document;
  }

  log.info("RERANK", `query_len=${body.query.length} docs=${body.documents.length} model=${upstreamBody.model}`);

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(GITEE_RERANK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${providerApiKey}`,
      },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    const msg = error?.name === "TimeoutError" ? "Rerank upstream timeout (60s)" : `Rerank fetch error: ${error?.message}`;
    log.error("RERANK", msg);
    return errorResponse(HTTP_STATUS.BAD_GATEWAY, msg);
  }

  if (!upstreamResponse.ok) {
    const text = await upstreamResponse.text().catch(() => "unknown");
    log.error("RERANK", `Upstream ${upstreamResponse.status}: ${text.slice(0, 200)}`);
    return errorResponse(upstreamResponse.status, `Rerank upstream error: ${text.slice(0, 500)}`);
  }

  const result = await upstreamResponse.json();
  log.info("RERANK", `Success | results=${result?.results?.length || 0}`);

  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

/**
 * Resolve rerank API key: check provider-nodes first, then env fallback.
 */
async function resolveRerankApiKey() {
  try {
    const { getProviderNodes } = await import("@/lib/localDb");
    const nodes = await getProviderNodes();
    const rerankNode = nodes.find(
      (n) => n.type === "custom-rerank" || n.type === "rerank"
    );
    if (rerankNode?.apiKey) return rerankNode.apiKey;
  } catch {
    // ignore — fall through to env
  }

  // Env fallback
  return process.env.GITEE_API_KEY || process.env.RERANK_API_KEY || null;
}

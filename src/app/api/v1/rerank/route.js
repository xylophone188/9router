import { handleRerank } from "@/sse/handlers/rerank.js";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/rerank - Rerank endpoint
 */
export async function POST(request) {
  return await handleRerank(request);
}

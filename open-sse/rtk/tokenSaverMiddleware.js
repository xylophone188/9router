/**
 * 9router token-saver middleware: secret masking + think-block stripping.
 * 
 * Integrated into chatCore.js response pipeline.
 * - Request side: mask API keys/secrets in tool_result content before sending to provider
 * - Response side: strip <think> blocks from streaming responses to reduce output tokens
 * 
 * Adapted from:
 * - llm-stream-guard (01laky) — secret redaction concept
 * - thinkstrip (informity) — stateful think-block filter
 */

import { TransformStream } from "node:stream/web";

// === Secret masking ===
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,           // OpenAI-style keys
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,     // Anthropic keys
  /Bearer\s+[a-zA-Z0-9_.-]{20,}/g,   // Bearer tokens
  /[a-f0-9]{64}/g,                    // SHA256 hashes (API keys)
  /AIza[a-zA-Z0-9_-]{35,}/g,         // Google API keys
  /ghp_[a-zA-Z0-9]{36,}/g,           // GitHub tokens
  /xox[bpoa]-[a-zA-Z0-9-]+/g,        // Slack tokens
];

const SECRET_PLACEHOLDER = "[REDACTED]";

export function maskSecrets(text) {
  if (!text || typeof text !== "string") return text;
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, SECRET_PLACEHOLDER);
  }
  return result;
}

// Mask secrets in request body tool_result content
export function maskSecretsInBody(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  
  for (const msg of body.messages) {
    if (!msg) continue;
    
    // Mask in string content
    if (typeof msg.content === "string") {
      msg.content = maskSecrets(msg.content);
    }
    
    // Mask in array content (tool_result blocks)
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block) continue;
        if (typeof block.content === "string") {
          block.content = maskSecrets(block.content);
        }
        if (Array.isArray(block.content)) {
          for (const part of block.content) {
            if (part && typeof part.text === "string") {
              part.text = maskSecrets(part.text);
            }
          }
        }
      }
    }
    
    // Mask in tool messages
    if (msg.role === "tool" && typeof msg.content === "string") {
      msg.content = maskSecrets(msg.content);
    }
  }
  
  return body;
}

// === Think-block stripping (streaming) ===
// Stateful filter that removes <think>...</think> blocks from streaming output.
// Adapted from thinkstrip (informity/thinkstrip).

const THINK_OPEN_TAGS = ["<think>", "<<think?>>"];
const THINK_CLOSE_TAGS = ["</think>", "<<endthink>>"];

export function createThinkStripStream() {
  let buffer = "";
  let inThinkBlock = false;
  let pendingOpen = "";
  
  return new TransformStream({
    transform(chunk, controller) {
      const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      buffer += text;
      
      let output = "";
      
      while (buffer.length > 0) {
        if (inThinkBlock) {
          // Look for close tag
          let closeIdx = -1;
          let closeTag = "";
          for (const tag of THINK_CLOSE_TAGS) {
            const idx = buffer.indexOf(tag);
            if (idx !== -1 && (closeIdx === -1 || idx < closeIdx)) {
              closeIdx = idx;
              closeTag = tag;
            }
          }
          
          if (closeIdx !== -1) {
            // Found close tag — skip everything up to and including it
            buffer = buffer.slice(closeIdx + closeTag.length);
            inThinkBlock = false;
          } else {
            // Still in think block — keep buffering
            // Check for partial close tag at end
            let minKeep = 0;
            for (const tag of THINK_CLOSE_TAGS) {
              for (let i = tag.length - 1; i > 0; i--) {
                if (buffer.endsWith(tag.slice(0, i))) {
                  minKeep = Math.max(minKeep, i);
                }
              }
            }
            if (buffer.length > minKeep) {
              buffer = buffer.slice(-minKeep || undefined);
            }
            break;
          }
        } else {
          // Look for open tag
          let openIdx = -1;
          let openTag = "";
          for (const tag of THINK_OPEN_TAGS) {
            const idx = buffer.indexOf(tag);
            if (idx !== -1 && (openIdx === -1 || idx < openIdx)) {
              openIdx = idx;
              openTag = tag;
            }
          }
          
          if (openIdx !== -1) {
            // Found open tag — emit everything before it
            output += buffer.slice(0, openIdx);
            buffer = buffer.slice(openIdx + openTag.length);
            inThinkBlock = true;
          } else {
            // No open tag found — emit all but keep potential partial tag
            let minKeep = 0;
            for (const tag of THINK_OPEN_TAGS) {
              for (let i = tag.length - 1; i > 0; i--) {
                if (buffer.endsWith(tag.slice(0, i))) {
                  minKeep = Math.max(minKeep, i);
                }
              }
            }
            if (buffer.length > minKeep) {
              output += buffer.slice(0, buffer.length - minKeep);
              buffer = buffer.slice(-minKeep);
            }
            break;
          }
        }
      }
      
      if (output) {
        controller.enqueue(output);
      }
    },
    
    flush(controller) {
      // End of stream — emit any remaining buffer (if not in think block)
      if (!inThinkBlock && buffer) {
        controller.enqueue(buffer);
      }
      buffer = "";
    },
  });
}

// === Batch think strip for non-streaming responses ===
export function stripThinkBlocks(text) {
  if (!text || typeof text !== "string") return text;
  let result = text;
  for (let i = 0; i < THINK_OPEN_TAGS.length; i++) {
    const open = THINK_OPEN_TAGS[i];
    const close = THINK_CLOSE_TAGS[i];
    const regex = new RegExp(
      open.replace(/[<>*?]/g, "\\$&") + 
      "[\\s\\S]*?" + 
      close.replace(/[<>*?]/g, "\\$&"),
      "g"
    );
    result = result.replace(regex, "");
  }
  return result;
}

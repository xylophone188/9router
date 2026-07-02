# 9router — Enhanced Fork

> Fork of [decolua/9router](https://github.com/decolua/9router) with token-saving pipeline, OpenViking shared memory, smart rate limiting, and budget guard.

## What's Added vs Upstream

### 🔧 Token Saver Pipeline (9-layer)
| Layer | Function | File |
|-------|----------|------|
| RTK | Tool output compression (Rust binary) | via plugin |
| Headroom | Prompt proxy compression | `chatCore.js` |
| Caveman | Ultra-terse response style | `chatCore.js` |
| Ponytail | Lazy senior-dev code style (+Review mode) | `ponytailPrompt.js` |
| Secret Masking | API key pattern redaction in tool outputs | `tokenSaverMiddleware.js` |
| Think Strip | `thinking` block stripping from responses | `tokenSaverMiddleware.js` |
| OpenViking Memory | Cross-agent shared memory injection | `openvikingMemory.js` |
| Cache Control | Anthropic-style cache_control markers for 9router proxy | `agent_runtime_helpers.py` (Hermes-side) |
| Headroom protect | Protected `read_file`/`terminal`/`web_extract` from compression | env config |

### 🧠 OpenViking Shared Memory
- All agents (Claude Code, Codex, Hermes, OpenClaw, Kilo) get shared memory via 9router
- Smart filtering: skip short/command/URL queries, 60s cache per query
- Dead-loop prevention: OV internal models (vlm/embed/rerank/whisper) are excluded
- Web UI toggle: Dashboard → Token Saver → OpenViking Memory

### 🚦 Rate Limit & Budget Guard
- TPM/RPM sliding-window rate limiter per API key
- Daily/monthly/per-request budget hard ceiling
- Returns HTTP 429 (rate limit) or 402 (budget exceeded)
- In-memory stats visible via API

### 💰 Semantic Cache
- In-memory response cache with TTL (1h default)
- OV-backed semantic search layer for similar-prompt cache hits

### 🌐 Web UI Enhancements
- Ponytail "Review" level (read-only code analysis)
- OpenViking Memory toggle + configuration card

## Prerequisites
- Node.js 20+
- Docker (for Headroom)
- OpenViking server (for shared memory)

## Quick Start
```bash
git clone https://github.com/xylophone188/9router.git
cd 9router
npm install
cp .env.example .env
# Edit .env with your settings
npm run dev
```

## OpenViking Integration (optional)
1. Run OpenViking server on port 1933
2. Set env: `OPENVIKING_ENABLED=true`, `OPENVIKING_URL=http://localhost:1933`
3. Enable in Dashboard → Token Saver → OpenViking Memory

## Rate Limits & Budget (optional)
Settings can be configured per-provider in the settings DB:
- `rateLimit.maxRequests` — max RPM
- `rateLimit.maxTokens` — max TPM
- `budget.daily` — daily USD ceiling
- `budget.monthly` — monthly USD ceiling
- `budget.hard` — per-request USD ceiling

## License
MIT (same as upstream)

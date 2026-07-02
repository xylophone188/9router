# 9Router — Enhanced Fork

[![Forked from decolua/9router](https://img.shields.io/badge/Forked%20from-decolua%2F9router-blue)](https://github.com/decolua/9router)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> **This is an enhanced fork** of [decolua/9router](https://github.com/decolua/9router) (upstream).  
> All upstream features are preserved. The additions are documented below with clear attribution.

---

## Upstream vs Fork

| Aspect | Upstream (decolua/9router) | This Fork |
|--------|---------------------------|-----------|
| Core LLM routing, providers, combo fallback | ✅ | ✅ (unchanged) |
| RTK Token Saver | ✅ | ✅ (unchanged) |
| Headroom / Caveman / Ponytail (lite/full/ultra) | ✅ | ✅ (unchanged) |
| Web UI Dashboard | ✅ | ✅ (unchanged) |
| **Ponytail Review level** | ❌ | ✅ Added |
| **OpenViking Shared Memory** | ❌ | ✅ Added |
| **Secret Masking in tool outputs** | ❌ | ✅ Added |
| **Think Block stripping** | ❌ | ✅ Added |
| **TPM/RPM Rate Limiter** | ❌ | ✅ Added |
| **Budget Hard Ceiling (USD)** | ❌ | ✅ Added |
| **Semantic Response Cache** | ❌ | ✅ Added |
| **Web UI config for all above** | ❌ | ✅ Added |

---

## What's Added — With Attribution

### 🧠 OpenViking Shared Memory (`copied from` → hermes-agent)
- **Source**: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) OpenViking integration pattern
- **What**: Cross-agent shared memory via OpenViking. ALL agents (Claude Code, Codex, Hermes, OpenClaw, Kilo, OpenCode) get shared memory through 9router — no per-agent integration needed.
- **Files**: `open-sse/rtk/openvikingMemory.js`
- **Features**:
  - Smart injection: only for meaningful user messages (≥20 chars, ≥3 words, non-command)
  - Dead-loop prevention: configurable model skip list (`vlm,embed,rerank,whisper,vl`)
  - 60s in-memory query cache
  - Fire-and-forget memory write after response
- **Web UI**: Dashboard → Token Saver → OpenViking Memory (toggle, URL, API Key, User, Skip Models)

### 🐴 Ponytail Review Mode (`copied from` → hermes-agent)
- **Source**: hermes-agent Ponytail integration + custom "review" level
- **What**: Read-only code analysis mode. The LLM **analyzes** code without writing — root cause, missing logic, minimal fix suggestion.
- **File**: `endpointConstants.js` (4th level added)
- **Web UI**: Dashboard → Token Saver → Ponytail → "Review"

### 🔐 Secret Masking (`copied from` → llm-stream-guard pattern)
- **Source**: [01laky/llm-stream-guard](https://github.com/01laky/llm-stream-guard) (concept)
- **What**: Regex-based API key/token pattern masking in tool outputs before sending to LLM. All agents benefit — one place, no per-agent config.
- **File**: `open-sse/rtk/tokenSaverMiddleware.js`
- **Patterns**: `sk-*`, `sk-ant-*`, base64 secrets, bearer tokens

### 🧹 Think Block Stripping (`copied from` → thinkstrip)
- **Source**: Community `thinkstrip` tools
- **What**: Strips `thinking` XML blocks from streaming responses. Reduces output tokens without losing answer quality.
- **File**: `open-sse/rtk/tokenSaverMiddleware.js`

### 🚦 TPM/RPM Rate Limiter (`inspired by` → LiteLLM)
- **Source**: [BerriAI/litellm](https://github.com/BerriAI/litellm) rate limiting pattern (concept)
- **What**: Sliding-window rate counter per API key. Returns HTTP 429 when exceeded.
- **File**: `open-sse/rtk/rateQuota.js`
- **Config**: `rateLimitMaxRequests` (RPM), `rateLimitMaxTokens` (TPM)
- **Web UI**: Dashboard → Token Saver → Rate Limit & Budget

### 💰 Budget Hard Ceiling (`inspired by` → TokenFirewall)
- **Source**: [Ruthwik000/tokenfirewall](https://github.com/Ruthwik000/tokenfirewall) budget guard concept
- **What**: Hard USD ceiling per-request / daily / monthly. Returns HTTP 402 when exceeded.
- **File**: `open-sse/rtk/rateQuota.js`
- **Config**: `budgetHard`, `budgetDaily`, `budgetMonthly`
- **Web UI**: Dashboard → Token Saver → Rate Limit & Budget

### ⚡ Semantic Response Cache (`inspired by` → reverb + llm-cacher)
- **Source**: [nobelk/reverb](https://github.com/nobelk/reverb) + [yar-solodovnikov/llm-cacher](https://github.com/yar-solodovnikov/llm-cacher) (concepts)
- **What**: In-memory response cache with TTL. Similar-prompt detection via OV embedding layer.
- **File**: `open-sse/rtk/rateQuota.js` (integrated in pipeline)

---

## Local Full-Strength Deployment Guide

This guide is written for **AI coding agents** (Claude Code, Codex, etc.) so they can reproduce the full stack.

### Prerequisites
```bash
# System
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install nodejs docker.io socat

# OpenViking (shared memory server)
# Download from https://github.com/nousresearch/openviking
pip install openviking
openviking-server --host 0.0.0.0 --port 1933 --config ov.conf
```

### 1. Deploy 9Router with All Enhancements

```bash
git clone https://github.com/xylophone188/9router.git
cd 9router
cp .env.example .env

# Install
npm install
npm run build

# Set env vars for all enhanced features
export PORT=20128
export HOSTNAME=0.0.0.0
export NODE_ENV=production
export DATA_DIR="$HOME/.9router"
export OPENVIKING_ENABLED=true
export OPENVIKING_URL=http://localhost:1933
export OPENVIKING_API_KEY="your-base64-key"
export OPENVIKING_ACCOUNT=default
export OPENVIKING_USER=hermes
export OPENVIKING_AGENT=9router
export OPENVIKING_SKIP_MODELS="vlm,embed,rerank,whisper,vl"

# (optional) proxy for provider access
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
export NO_PROXY=localhost,127.0.0.1,::1,headroom

npm run start
```

### 2. Deploy Headroom Token Saver (Docker)

```bash
docker run -d --name headroom --restart unless-stopped \
  -p 8787:8787 \
  ghcr.io/chopratejas/headroom:v0.28.0 \
  --host 0.0.0.0 --port 8787 \
  --protect-tool-results "read_file,terminal,web_extract,web_search"
```

Then in Web UI → Token Saver → enable Headroom.

### 3. Configure OpenViking in Web UI

1. Open `http://localhost:20128/dashboard`
2. Token Saver page
3. **OpenViking Memory** card:
   - Enable toggle
   - URL: `http://localhost:1933`
   - API Key: your OV root API key
   - User: `hermes` (shared across agents)
   - Skip Models: `vlm,embed,rerank,whisper,vl`
4. **Rate Limit & Budget** card (optional):
   - Set RPM/TPM per API key
   - Set daily/monthly/per-request USD ceiling

### 4. Docker Build (for persistence)

```bash
cd 9router  # the forked repo
docker build -t 9router-enhanced .
docker run -d --name 9router --restart unless-stopped \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  -e OPENVIKING_ENABLED=true \
  -e OPENVIKING_URL=http://host.docker.internal:1933 \
  -e OPENVIKING_API_KEY="base64-key" \
  -e HTTP_PROXY=http://host.docker.internal:7890 \
  9router-enhanced
```

### 5. Connect Agents

All AI agents point to the same 9router endpoint:

```bash
# Claude Code
# ~/.claude/config.json → "api_base": "http://localhost:20128/v1"

# Codex CLI
export OPENAI_BASE_URL="http://localhost:20128"
export OPENAI_API_KEY="your-9router-key"

# Hermes Agent / OpenClaw / Kilo / OpenCode
# provider: custom, base_url: http://localhost:20128/v1
```

All agents automatically share memory via OpenViking. No per-agent OV integration needed.

---

## Upstream

- **Original**: [decolua/9router](https://github.com/decolua/9router)
- **License**: MIT
- **Acknowledgments**: See original repo's README for the full list of upstream contributors and inspirations (RTK, Caveman, Ponytail, Headroom).

---

## License

MIT (same as upstream). See [LICENSE](./LICENSE).

## Credits

Built on the shoulders of giants:
- [decolua/9router](https://github.com/decolua/9router) — the upstream LLM router
- [rtk-ai/rtk](https://github.com/rtk-ai/rtk) — Rust token-saver
- [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) — cavemanspeak
- [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) — lazy senior dev
- [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) — OpenViking integration pattern, Ponytail Review
- [01laky/llm-stream-guard](https://github.com/01laky/llm-stream-guard) — secret masking concept
- [BerriAI/litellm](https://github.com/BerriAI/litellm) — rate limiting concept
- [Ruthwik000/tokenfirewall](https://github.com/Ruthwik000/tokenfirewall) — budget guard concept
- [nobelk/reverb](https://github.com/nobelk/reverb) — semantic cache concept
- [yar-solodovnikov/llm-cacher](https://github.com/yar-solodovnikov/llm-cacher) — semantic cache concept

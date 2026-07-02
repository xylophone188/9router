/**
 * Advisor Embedding — L2 语义分类器（combo 模式）
 * 
 * 通过 embedding 相似度判断请求属于 work 还是 advisory。
 * 使用 9router 的 semantic-analysis combo 获取 embedding provider，
 * 不硬编码任何模型，支持通过 Dashboard 动态调整。
 */

import { getEmbeddingAdapter } from "open-sse/handlers/embeddingProviders/index.js";
import { getProviderConnections, getComboByName } from "@/lib/localDb.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { getDataDir } from "@/lib/dataDir.js";
import * as log from "../utils/logger.js";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const TAG = "ADVISOR_EMBEDDING";

let _samples = null;
let _centroids = null;
let _comboName = null;
let _ready = false;
let _lastLoadTime = 0;

export async function initEmbeddingClassifier(forceReload = false) {
  try {
    const samplesData = await _loadSamples(forceReload);
    if (!samplesData?.samples?.length) {
      log.warn(TAG, "无标注样本，L2 分类器不可用");
      _ready = false;
      return false;
    }

    const settings = await getSettings();
    _comboName = settings.advisorL2Combo || "semantic-analysis";

    const combo = await getComboByName(_comboName);
    if (!combo?.models?.length) {
      log.warn(TAG, `Combo '"'"'${_comboName}'"'"' 无可用模型，L2 分类器不可用`);
      _ready = false;
      return false;
    }

    _centroids = _computeCentroids(samplesData);
    if (!_centroids) {
      log.warn(TAG, "无法计算 centroid，L2 分类器不可用");
      _ready = false;
      return false;
    }

    _samples = samplesData;
    _ready = true;
    _lastLoadTime = Date.now();

    log.info(TAG, `L2 分类器就绪: combo=${_comboName}, samples=${samplesData.samples.length}`);
    return true;
  } catch (error) {
    log.error(TAG, `初始化失败: ${error.message}`);
    _ready = false;
    return false;
  }
}

export function isReady() { return _ready; }

export async function classifyByEmbedding(text) {
  if (!_ready) return { intent: "work", confidence: 0, similarity: null, reason: "not_ready" };
  if (!text?.trim()) return { intent: "work", confidence: 0, similarity: null, reason: "empty_text" };

  const settings = await getSettings();
  const maxLen = settings.advisorL2MaxTextLength || 2000;
  const truncated = text.length > maxLen ? text.slice(0, maxLen) : text;

  try {
    const embedding = await _getEmbedding(truncated);
    if (!embedding) return { intent: "work", confidence: 0, similarity: null, reason: "embedding_failed" };

    const simWork = cosineSimilarity(embedding, _centroids.work);
    const simAdvisory = cosineSimilarity(embedding, _centroids.advisory);

    const total = simWork + simAdvisory;
    const confidence = total > 0 ? Math.abs(simWork - simAdvisory) / total : 0;
    const intent = simWork >= simAdvisory ? "work" : "advisory";

    return {
      intent,
      confidence: Math.min(confidence, 1),
      similarity: { work: simWork, advisory: simAdvisory },
      reason: "embedding",
    };
  } catch (error) {
    log.warn(TAG, `分类失败: ${error.message}`);
    return { intent: "work", confidence: 0, similarity: null, reason: `error: ${error.message}` };
  }
}

// ─── combo → provider 解析 ───────────────────────────────

function resolveModel(modelStr) {
  if (modelStr.includes("/")) {
    const [provider, ...modelParts] = modelStr.split("/");
    return { provider, model: modelParts.join("/") };
  }
  return null;
}

async function _getEmbedding(text) {
  const combo = await getComboByName(_comboName);
  if (!combo?.models?.length) return null;

  for (const modelStr of combo.models) {
    if (!modelStr || modelStr === "free" || modelStr === "cost" || modelStr === "whiteFree") continue;

    const parsed = resolveModel(modelStr);
    if (!parsed) continue;

    const { provider, model } = parsed;
    const adapter = getEmbeddingAdapter(provider);
    if (!adapter) continue;

    const connections = await getProviderConnections({ provider, isActive: true });
    if (!connections.length) continue;

    for (const conn of connections) {
      try {
        const url = adapter.buildUrl(model, conn.credentials, { input: text });
        const headers = adapter.buildHeaders(conn.credentials, { input: text });
        const body = adapter.buildBody(model, { input: text, encoding_format: "float" });

        const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        if (!response.ok) continue;

        const data = await response.json();
        const normalized = adapter.normalize(data, model);
        const embedding = _extractEmbedding(normalized);
        if (embedding) return embedding;
      } catch {
        continue;
      }
    }
  }

  // Fallback: 所有 combo 模型都失败，尝试任意可用 embedding provider
  const allConnections = await getProviderConnections({ isActive: true });
  for (const conn of allConnections) {
    const adapter = getEmbeddingAdapter(conn.provider);
    if (!adapter) continue;

    try {
      const model = conn.provider === "nvidia" ? "nv-embedqa-e5-v5" :
                   conn.provider === "mistral" ? "mistral-embed" :
                   conn.provider === "gemini" ? "text-embedding-004" :
                   conn.provider === "openai" ? "text-embedding-3-small" : null;
      if (!model) continue;

      const url = adapter.buildUrl(model, conn.credentials, { input: text });
      const headers = adapter.buildHeaders(conn.credentials, { input: text });
      const body = adapter.buildBody(model, { input: text, encoding_format: "float" });

      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      if (!response.ok) continue;

      const data = await response.json();
      const normalized = adapter.normalize(data, model);
      const embedding = _extractEmbedding(normalized);
      if (embedding) {
        log.warn(TAG, `Fallback embedding: ${conn.provider}/${model}`);
        return embedding;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function _extractEmbedding(normalized) {
  if (normalized.data?.[0]?.embedding) return normalized.data[0].embedding;
  if (Array.isArray(normalized)) return normalized;
  return null;
}

// ─── 样本管理 ───────────────────────────────────────────

const SAMPLES_PATH = resolve(getDataDir(), "labeled_samples.json");

async function _loadSamples(forceReload = false) {
  try {
    if (!forceReload && _samples && _lastLoadTime > 0) return _samples;
    const content = readFileSync(SAMPLES_PATH, "utf-8");
    const data = JSON.parse(content);
    const valid = data.samples?.filter(s => s.text && (s.category === "work" || s.category === "advisory")) || [];
    return { ...data, samples: valid };
  } catch (error) {
    if (error.code === "ENOENT") {
      log.warn(TAG, `样本文件不存在: ${SAMPLES_PATH}`);
    } else {
      log.error(TAG, `加载样本失败: ${error.message}`);
    }
    return null;
  }
}

function _computeCentroids(samplesData) {
  const { samples } = samplesData;
  const byCategory = { work: [], advisory: [] };
  for (const sample of samples) {
    if (sample.category === "work") byCategory.work.push(sample);
    else if (sample.category === "advisory") byCategory.advisory.push(sample);
  }

  if (byCategory.work.length === 0 || byCategory.advisory.length === 0) {
    log.error(TAG, "样本必须同时包含 work 和 advisory 两个类别");
    return null;
  }

  // 使用预计算 embedding（如果存在）
  const centroids = {};
  for (const category of ["work", "advisory"]) {
    const withEmbedding = byCategory[category].filter(s => s.embedding && Array.isArray(s.embedding));
    if (withEmbedding.length > 0) {
      centroids[category] = averageVectors(withEmbedding.map(s => s.embedding));
    }
  }

  return centroids.work && centroids.advisory ? centroids : null;
}

/**
 * 重新计算所有样本的 embedding 并更新文件
 */
export async function recomputeAllEmbeddings(provider = "nvidia", model = "nv-embedqa-e5-v5") {
  const adapter = getEmbeddingAdapter(provider);
  if (!adapter) { log.error(TAG, `Provider '${provider}' 不支持 embedding`); return false; }

  const samplesData = await _loadSamples(true);
  if (!samplesData) return false;

  const connections = await getProviderConnections({ provider, isActive: true });
  if (!connections.length) { log.error(TAG, `No active connections for provider: ${provider}`); return false; }

  const conn = connections[0];
  let success = 0, failed = 0;

  for (const sample of samplesData.samples) {
    try {
      const url = adapter.buildUrl(model, conn.credentials, { input: sample.text });
      const headers = adapter.buildHeaders(conn.credentials, { input: sample.text });
      const body = adapter.buildBody(model, { input: sample.text, encoding_format: "float" });

      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      if (!response.ok) { failed++; continue; }

      const data = await response.json();
      const normalized = adapter.normalize(data, model);
      const embedding = _extractEmbedding(normalized);

      if (embedding) { sample.embedding = embedding; success++; }
      else { failed++; }
    } catch { failed++; }
  }

  samplesData.stats = {
    ...samplesData.stats,
    work_count: samplesData.samples.filter(s => s.category === "work").length,
    advisory_count: samplesData.samples.filter(s => s.category === "advisory").length,
    embedding_provider: provider,
    embedding_model: model,
    updated_at: new Date().toISOString(),
  };

  const fs = await import("node:fs/promises");
  await fs.writeFile(SAMPLES_PATH, JSON.stringify(samplesData, null, 2));
  log.info(TAG, `Embedding 重计算完成: success=${success}, failed=${failed}`);

  await initEmbeddingClassifier(true);
  return true;
}

// ─── 向量运算 ───────────────────────────────────────────

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function averageVectors(vectors) {
  if (!vectors.length) return null;
  const dim = vectors[0].length;
  const sum = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) sum[i] += v[i];
  return sum.map(v => v / vectors.length);
}

// ─── 统计信息 ───────────────────────────────────────────

export function getStats() {
  if (!_samples) return null;
  return {
    ready: _ready,
    combo: _comboName,
    totalSamples: _samples.samples?.length || 0,
    workSamples: _samples.samples?.filter(s => s.category === "work").length || 0,
    advisorySamples: _samples.samples?.filter(s => s.category === "advisory").length || 0,
    hasCentroids: !!_centroids,
    lastLoadTime: _lastLoadTime,
  };
}

export async function maybeReload() {
  const now = Date.now();
  if (now - _lastLoadTime < 5 * 60 * 1000) return false;
  try {
    const fs = await import("node:fs/promises");
    const stat = await fs.stat(SAMPLES_PATH);
    if (stat.mtimeMs > _lastLoadTime) {
      log.info(TAG, "检测到样本文件更新，重新加载...");
      return await initEmbeddingClassifier(true);
    }
  } catch {}
  return false;
}

export { cosineSimilarity };

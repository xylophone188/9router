/**
 * ClassificationV2 — L1→L2→L3 级联分类器
 * 
 * 三级分类架构：
 *   L1: 关键词规则（快速、零成本）
 *   L2: embedding 语义相似度（廉价、中等延迟）— shadow/active 双模式
 *   3: LLM 分类（昂贵、高延迟，仅做兜底）
 * 
 * 模式：
 *   shadow: L2 异步运行，仅记录不影响路由
 *   active: L2 同步运行，参与路由决策
 */

import { detectIntentByRules, selectTargetModel } from "open-sse/services/advisor.js";
import { classifyByEmbedding, extractRecentText } from "./advisorEmbedding.js";
import { classifyIntent as llmClassifyIntent } from "open-sse/services/advisor.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import * as log from "../utils/logger.js";

const TAG = "CLASSIFY_V2";

/**
 * 级联分类主入口
 * @param {Array} messages - 聊天消息
 * @param {object} settings - 全局设置
 * @param {object} options - 选项
 * @param {Function} options.callClassifier - LLM 分类器回调
 * @param {boolean} options.shadowMode - 是否仅 shadow 模式（不改变主流程行为）
 * @returns {Promise<{intent: string, source: string, confidence: string, reason: string, targetModel: string, l2?: object}>}
 */
export async function classifyIntentV2(messages, settings, options = {}) {
  const { callClassifier, shadowMode = false } = options;
  
  // ─── L1: 关键词规则 ──────────────────────────────────
  const l1Start = Date.now();
  const l1Result = detectIntentByRules(messages);
  const l1Ms = Date.now() - l1Start;

  // 如果 L1 高置信度，直接使用
  if (l1Result.confidence === "high") {
    const targetModel = selectTargetModel(l1Result.intent, settings);
    return {
      intent: l1Result.intent,
      source: "L1",
      confidence: l1Result.confidence,
      reason: l1Result.reason,
      targetModel,
      l1_ms: l1Ms,
    };
  }

  // ─── L1 中置信度：也直接使用（不触发 L2） ─────────
  if (l1Result.confidence === "medium") {
    const targetModel = selectTargetModel(l1Result.intent, settings);
    return {
      intent: l1Result.intent,
      source: "L1",
      confidence: l1Result.confidence,
      reason: l1Result.reason,
      targetModel,
      l1_ms: l1Ms,
    };
  }

  // ─── L1 低置信度：需要进一步分类 ────────────────────
  const text = extractRecentText(messages);
  
  // 检查 L2 是否启用
  const l2Enabled = settings.advisorL2Enabled && !shadowMode;
  const l2Active = settings.advisorL2Active && !shadowMode;
  
  if (l2Enabled && l2Active) {
    // ─── Active 模式：L2 参与决策 ───────────────────
    const l2Start = Date.now();
    const l2Result = await classifyByEmbedding(text);
    const l2Ms = Date.now() - l2Start;

    if (l2Result.confidence >= (settings.advisorL2ConfidenceThreshold || 0.75)) {
      // L2 高置信度：使用 L2
      const targetModel = selectTargetModel(l2Result.intent, settings);
      return {
        intent: l2Result.intent,
        source: "L2",
        confidence: "high",
        reason: `L2 embedding: work=${l2Result.similarity?.work.toFixed(3) || '?'}, advisory=${l2Result.similarity?.advisory.toFixed(3) || '?'}`,
        targetModel,
        l1_ms: l1Ms,
        l2_ms: l2Ms,
        l2: l2Result,
      };
    }
    
    // L2 低置信度：回退到 LLM 分类器
    if (callClassifier) {
      const l3Start = Date.now();
      const l3Result = await llmClassifyIntent(messages, settings, { callClassifier });
      const l3Ms = Date.now() - l3Start;
      
      return {
        ...l3Result,
        l1_ms: l1Ms,
        l2_ms: l2Ms,
        l3_ms: l3Ms,
        l2: l2Result,
      };
    }
    
    // 无 LLM 分类器，保守 fallback
    const intent = l2Result.intent || "work";
    const targetModel = selectTargetModel(intent, settings);
    return {
      intent,
      source: "L2-fallback",
      confidence: "low",
      reason: `L2 low confidence (${l2Result.confidence.toFixed(3)}), no LLM fallback`,
      targetModel,
      l1_ms: l1Ms,
      l2_ms: l2Ms,
      l2: l2Result,
    };
  }
  
  if (l2Enabled && !l2Active && !shadowMode) {
    // ─── Shadow 模式：L2 异步运行仅记录 ────────────
    // 先返回 L1 结果（保守 fallback）
    const l1Intent = l1Result.intent;
    const targetModel = selectTargetModel(l1Intent, settings);
    
    // 异步启动 L2（不 await，不影响主流程）
    const shadowPromise = classifyByEmbedding(text).then(l2Result => {
      // 记录 shadow 结果
      log.info(TAG, `Shadow L2 result: intent=${l2Result.intent}, confidence=${l2Result.confidence.toFixed(3)}, l1_intent=${l1Intent}`);
      return l2Result;
    }).catch(err => {
      log.warn(TAG, `Shadow L2 failed: ${err.message}`);
      return null;
    });

    return {
      intent: l1Intent,
      source: "L1-shadow-L2",
      confidence: l1Result.confidence,
      reason: l1Result.reason,
      targetModel,
      l1_ms: l1Ms,
      _shadowPromise: shadowPromise,
    };
  }
  
  // L2 未启用或 shadow 模式但已有 promise
  // 保守 fallback：优先 work，避免误判为 advisory
  const intent = l1Result.confidence === "low" ? "work" : l1Result.intent;
  const targetModel = selectTargetModel(intent, settings);
  
  return {
    intent,
    source: "L1-fallback",
    confidence: l1Result.confidence,
    reason: l1Result.reason,
    targetModel,
    l1_ms: l1Ms,
  };
}

/**
 * Shadow 模式专用：仅运行 L2 并返回结果，不改变路由
 */
export async function shadowClassify(messages, settings) {
  const text = extractRecentText(messages);
  const l1Result = detectIntentByRules(messages);
  
  if (!text.trim()) {
    return { l1: l1Result, l2: null };
  }
  
  try {
    const l2Result = await classifyByEmbedding(text);
    return { l1: l1Result, l2: l2Result };
  } catch (error) {
    log.warn(TAG, `Shadow classify failed: ${error.message}`);
    return { l1: l1Result, l2: null, error: error.message };
  }
}

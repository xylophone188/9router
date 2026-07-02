/**
 * Advisor Shadow — L2 Shadow 记录器
 * 
 * 在 classifyIntent() 完成路由决策后，异步运行 L2 embedding 分类，
 * 将 L1 结果、LLM 结果（如有）、L2 结果、最终路由全部记录到 SQLite。
 * 
 * 零影响主流程：所有操作均为异步 fire-and-forget，带超时保护。
 */

import { classifyByEmbedding, extractRecentText } from "./advisorEmbedding.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { getDataDir } from "@/lib/dataDir.js";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import * as log from "../utils/logger.js";

const TAG = "ADVISOR_SHADOW";

// ─── 配置 ───────────────────────────────────────────────

const DB_PATH = resolve(getDataDir(), "advisor_shadow.sqlite");
const SHADOW_TIMEOUT_MS = 5000; // shadow 最长等待 5s

// ─── 状态 ───────────────────────────────────────────────

let _db = null;
let _ready = false;

// ─── 初始化 ─────────────────────────────────────────────

export function initShadowDb() {
  if (_ready) return true;
  
  try {
    _db = new DatabaseSync(DB_PATH);
    _db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      
      CREATE TABLE IF NOT EXISTS shadow_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        request_text TEXT NOT NULL,
        l1_intent TEXT,
        l1_confidence TEXT,
        l1_reason TEXT,
        l1_ms INTEGER,
        l2_intent TEXT,
        l2_confidence REAL,
        l2_similarity_work REAL,
        l2_similarity_advisory REAL,
        l2_ms INTEGER,
        l3_intent TEXT,
        l3_source TEXT,
        final_intent TEXT NOT NULL,
        final_target TEXT NOT NULL,
        final_source TEXT NOT NULL,
        agreement TEXT,
        shadow_total_ms INTEGER
      );
      
      CREATE INDEX IF NOT EXISTS idx_shadow_ts ON shadow_log(ts);
      CREATE INDEX IF NOT EXISTS idx_shadow_l1 ON shadow_log(l1_intent);
      CREATE INDEX IF NOT EXISTS idx_shadow_l2 ON shadow_log(l2_intent);
      CREATE INDEX IF NOT EXISTS idx_shadow_final ON shadow_log(final_intent);
      CREATE INDEX IF NOT EXISTS idx_shadow_agreement ON shadow_log(agreement);
      
      CREATE TABLE IF NOT EXISTS shadow_stats (
        date TEXT PRIMARY KEY,
        total INTEGER DEFAULT 0,
        l1_high INTEGER DEFAULT 0,
        l1_low INTEGER DEFAULT 0,
        l2_success INTEGER DEFAULT 0,
        l2_fail INTEGER DEFAULT 0,
        l2_timeout INTEGER DEFAULT 0,
        agreement_count INTEGER DEFAULT 0,
        disagreement_count INTEGER DEFAULT 0,
        avg_l2_ms REAL DEFAULT 0
      );
    `);
    
    _ready = true;
    log.info(TAG, `Shadow DB initialized: ${DB_PATH}`);
    return true;
  } catch (error) {
    log.error(TAG, `Shadow DB init failed: ${error.message}`);
    return false;
  }
}

export function isShadowReady() {
  return _ready;
}

// ─── 核心记录 ───────────────────────────────────────────

/**
 * 异步记录 shadow 结果（fire-and-forget）
 * @param {object} params
 * @param {string} params.text - 请求文本
 * @param {object} params.l1Result - L1 规则分类结果
 * @param {object} params.classification - classifyIntent() 返回结果
 * @param {number} params.l1Ms - L1 耗时
 */
export async function logShadowResult({ text, l1Result, classification, l1Ms }) {
  if (!_ready) {
    initShadowDb();
  }
  
  if (!_ready || !text?.trim()) {
    return;
  }
  
  const shadowStart = Date.now();
  
  try {
    // 运行 L2 分类（带超时）
    const l2Promise = classifyByEmbedding(text);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("timeout")), SHADOW_TIMEOUT_MS)
    );
    
    let l2Result = null;
    let l2Ms = 0;
    let l2Status = "success";
    
    try {
      const start = Date.now();
      l2Result = await Promise.race([l2Promise, timeoutPromise]);
      l2Ms = Date.now() - start;
    } catch (error) {
      l2Status = error.message === "timeout" ? "timeout" : "error";
    }
    
    const shadowTotalMs = Date.now() - shadowStart;
    
    // 判断一致性
    const l2Intent = l2Result?.intent || null;
    const l1Intent = l1Result?.intent || classification?.intent;
    const agreement = l2Intent ? (l1Intent === l2Intent ? "agree" : "disagree") : "no_l2";
    
    // 写入 SQLite
    const stmt = _db.prepare(`
      INSERT INTO shadow_log (
        ts, request_text, l1_intent, l1_confidence, l1_reason, l1_ms,
        l2_intent, l2_confidence, l2_similarity_work, l2_similarity_advisory, l2_ms,
        l3_intent, l3_source, final_intent, final_target, final_source,
        agreement, shadow_total_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      Date.now(),
      text.slice(0, 4000), // 截断过长文本
      l1Intent || null,
      l1Result?.confidence || null,
      l1Result?.reason || null,
      l1Ms || 0,
      l2Intent,
      l2Result?.confidence || null,
      l2Result?.similarity?.work || null,
      l2Result?.similarity?.advisory || null,
      l2Ms,
      classification?.source === "llm" ? classification.intent : null,
      classification?.source || null,
      classification?.intent || "work",
      classification?.targetModel || "work",
      classification?.source || "rules",
      agreement,
      shadowTotalMs
    );
    
    // 更新统计
    _updateStats(l1Result, l2Status, agreement, l2Ms);
    
    // 定期 checkpoint
    if (Math.random() < 0.01) {
      try { _db.exec("PRAGMA wal_checkpoint(TRUNCATE)); } catch {}
    }
    
  } catch (error) {
    // Shadow 错误不影响主流程
    log.debug(TAG, `Shadow log failed: ${error.message}`);
  }
}

function _updateStats(l1Result, l2Status, agreement, l2Ms) {
  try {
    const date = new Date().toISOString().slice(0, 10);
    
    // 确保日期行存在
    _db.prepare(`
      INSERT OR IGNORE INTO shadow_stats (date) VALUES (?)
    `).run(date);
    
    // 更新计数
    const updates = ["total = total + 1"];
    
    if (l1Result?.confidence === "high") updates.push("l1_high = l1_high + 1");
    else updates.push("l1_low = l1_low + 1");
    
    if (l2Status === "success") updates.push("l2_success = l2_success + 1");
    else if (l2Status === "timeout") updates.push("l2_timeout = l2_timeout + 1");
    else updates.push("l2_fail = l2_fail + 1");
    
    if (agreement === "agree") updates.push("agreement_count = agreement_count + 1");
    else if (agreement === "disagree") updates.push("disagreement_count = disagreement_count + 1");
    
    if (l2Ms > 0) {
      updates.push(`avg_l2_ms = (avg_l2_ms * (total - 1) + ${l2Ms}) / total`);
    }
    
    _db.prepare(`
      UPDATE shadow_stats SET ${updates.join(", ")} WHERE date = ?
    `).run(date);
    
  } catch {
    // 统计更新失败不影响主流程
  }
}

// ─── 查询 ───────────────────────────────────────────────

export function getStats(days = 7) {
  if (!_ready) return null;
  
  try {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    
    const total = _db.prepare(
      "SELECT COUNT(*) as c FROM shadow_log WHERE ts > ?"
    ).get(since)?.c || 0;
    
    const byL1 = _db.prepare(`
      SELECT l1_intent, COUNT(*) as c FROM shadow_log WHERE ts > ? GROUP BY l1_intent
    `).all(since);
    
    const byL2 = _db.prepare(`
      SELECT l2_intent, COUNT(*) as c FROM shadow_log WHERE ts > ? GROUP BY l2_intent
    `).all(since);
    
    const byAgreement = _db.prepare(`
      SELECT agreement, COUNT(*) as c FROM shadow_log WHERE ts > ? GROUP BY agreement
    `).all(since);
    
    const avgL2Ms = _db.prepare(`
      SELECT AVG(l2_ms) as avg FROM shadow_log WHERE ts > ? AND l2_ms > 0
    `).get(since)?.avg || 0;
    
    const recentDisagreements = _db.prepare(`
      SELECT request_text, l1_intent, l2_intent, l2_confidence, l2_similarity_work, l2_similarity_advisory
      FROM shadow_log WHERE ts > ? AND agreement = 'disagree'
      ORDER BY ts DESC LIMIT 20
    `).all(since);
    
    return {
      period: `${days}d`,
      total,
      byL1: Object.fromEntries(byL1.map(r => [r.l1_intent, r.c])),
      byL2: Object.fromEntries(byL2.map(r => [r.l2_intent, r.c])),
      byAgreement: Object.fromEntries(byAgreement.map(r => [r.agreement, r.c])),
      avgL2Ms: Math.round(avgL2Ms),
      recentDisagreements,
    };
  } catch (error) {
    log.error(TAG, `Get stats failed: ${error.message}`);
    return null;
  }
}

export function getDailyStats() {
  if (!_ready) return [];
  
  try {
    return _db.prepare(`
      SELECT date, total, l1_high, l1_low, l2_success, l2_fail, l2_timeout,
             agreement_count, disagreement_count, avg_l2_ms
      FROM shadow_stats ORDER BY date DESC
    `).all();
  } catch {
    return [];
  }
}

// ─── 清理 ───────────────────────────────────────────────

export function cleanup(daysToKeep = 30) {
  if (!_ready) return false;
  
  try {
    const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    const result = _db.prepare("DELETE FROM shadow_log WHERE ts < ?").run(cutoff);
    log.info(TAG, `Cleaned up ${result.changes} old shadow records`);
    
    // 清理过期统计
    const cutoffDate = new Date(cutoff).toISOString().slice(0, 10);
    _db.prepare("DELETE FROM shadow_stats WHERE date < ?").run(cutoffDate);
    
    try { _db.exec("PRAGMA wal_checkpoint(TRUNCATE)); } catch {}
    try { _db.exec("PRAGMA optimize"); } catch {}
    
    return true;
  } catch {
    return false;
  }
}

export function closeShadowDb() {
  if (_db) {
    try { _db.exec("PRAGMA wal_checkpoint(TRUNCATE)); } catch {}
    try { _db.close(); } catch {}
    _db = null;
    _ready = false;
  }
}

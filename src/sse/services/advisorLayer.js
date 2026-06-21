/**
 * Advisor Layer - 智力审核层
 * 多层降级链: claude-opus-4-8 → gpt-5.5 → gpt-5.4 → kimi-for-coding
 */

import path from "node:path";
import { getProviderConnections } from "@/lib/localDb.js";
import { isModelLockActive } from "open-sse/services/accountFallback.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { DatabaseSync } from "node:sqlite";
import { getDataDir } from "@/lib/dataDir.js";
import { parseReviewResponse } from "@/shared/constants/advisorMode.js";

// Advisor 系统提示词
const SYSTEM_PROMPT = `你是 9router 的顾问模式审核员。评估免费模型输出质量，决定是否接受或升级。

评估标准：
1. 回答完整准确
2. 无幻觉错误
3. 代码可运行
4. 推理清晰

输出规则：
- 质量合格 → 输出 "1"
- 需要升级 → 输出具体建议："增加并发" / "启用评审" / "切换模型" / "通知用户"

只输出一个关键词，不要解释。`;

// 默认降级链（会被 settings 覆盖）
const DEFAULT_ADVISOR_TIERS = [
  { provider: "claude", models: ["claude-opus-4-8"] },
  { provider: "tkmyself-claude", models: ["gpt-5.5", "gpt-5.4"] },
  { provider: "kimi", models: ["kimi-for-coding"] },
];

const QUOTA_TARGET_PER_HOUR = 5;

function matchesAdvisorProvider(connection, tierProvider) {
  const prefix = connection.providerSpecificData?.prefix || connection.nodeName;
  if (prefix === tierProvider || connection.provider === tierProvider)
    return true;
  const haystack =
    `${connection.provider || ""} ${connection.name || ""} ${connection.baseUrl || ""}`.toLowerCase();
  if (tierProvider === "tkmyself-claude") return haystack.includes("tokenx24");
  if (tierProvider === "kimi")
    return haystack.includes("kimi.com") || haystack.includes("kimi");
  return false;
}

async function readAdvisorText(response) {
  if (!response) return "";
  if (typeof response === "string") return response;
  if (typeof response.text === "function") return await response.text();
  if (typeof response.content === "string") return response.content;
  if (typeof response.feedback === "string") return response.feedback;
  if (typeof response.response?.text === "function") return await response.response.text();
  if (typeof response.response?.content === "string") return response.response.content;
  return String(response);
}

/**
 * 获取可用的 advisor provider/model（按降级链）
 */
export async function getAdvisorCredentials() {
  const settings = await getSettings();
  const tiers = settings.advisorTiers || DEFAULT_ADVISOR_TIERS;

  for (const tier of tiers) {
    // 通过 prefix/nodeName 匹配 provider 别名 — 仅活跃连接
    const allConnections = await getProviderConnections({ isActive: true });
    const activeConnections = allConnections.filter((c) => {
      if (c.testStatus !== "active" || !c.apiKey) return false;
      return matchesAdvisorProvider(c, tier.provider);
    });
    console.log(
      "[ADVISOR_DEBUG]",
      "tier=" +
        tier.provider +
        ", total=" +
        allConnections.length +
        ", active=" +
        activeConnections.length,
    );

    if (activeConnections.length === 0) continue;

    for (const model of tier.models) {
      const usableConnection = activeConnections.find(
        (c) => !isModelLockActive(c, model),
      );
      if (!usableConnection) continue;

      return {
        provider: usableConnection.provider,
        model,
        connectionId: usableConnection.id,
      };
    }
  }

  console.log("[ADVISOR]", "所有 advisor 层级均不可用");
  return { provider: "kimi", model: "kimi-for-coding", connectionId: null };
}

/**
 * 审核方案（advisor 层）
 * @param {string} question - 问题/背景
 * @param {string} freeModelOutput - 免费模型生成的方案
 * @param {Function} executeRequest - 执行请求的函数
 * @returns {{ approved: boolean, feedback: string|null }}
 */
export async function reviewWithAdvisor(
  question,
  freeModelOutput,
  executeRequest,
) {
  const settings = await getSettings();
  if (settings.localFeaturesEnabled === false) {
    return { approved: true, feedback: null, action: null };
  }

  const { provider, model } = await getAdvisorCredentials();

  console.log(
    "[ADVISOR]",
    "审核请求: " +
      question.slice(0, 50) +
      "... (advisor: " +
      provider +
      "/" +
      model +
      ")",
  );

  const response = await executeRequest({
    provider,
    model,
    messages: [
      {
        role: "system",
        content:
          '你是一个严格的代码审查专家。只输出 "1" 表示通过，或输出具体的修改建议表示需要修改。不要解释原因，不要输出额外文字。',
      },
      {
        role: "user",
        content:
          "请审查以下代码方案是否正确：\n\n问题: " +
          question +
          "\n\n方案:\n" +
          freeModelOutput +
          '\n\n请只输出 "1" 或具体的修改建议。',
      },
    ],
    max_tokens: 100,
  });

  const responseText = await readAdvisorText(response);
  const result = parseAdvisorResponse(responseText);
  const action = result.approved || !result.feedback ? null : (() => {
    const lower = result.feedback.toLowerCase();
    if (
      lower.includes("并发") ||
      lower.includes("concurrency") ||
      lower.includes("blast")
    ) {
      return { type: "increase_blast_concurrency", delta: 2 };
    }
    if (
      lower.includes("judge") ||
      lower.includes("评审") ||
      lower.includes("评分")
    ) {
      return { type: "enable_judge" };
    }
    if (
      lower.includes("切换") ||
      lower.includes("switch") ||
      lower.includes("tier")
    ) {
      return { type: "switch_advisor_tier" };
    }
    if (lower.includes("通知") || lower.includes("notify")) {
      return { type: "notify" };
    }
    return { type: "generic", task: result.feedback };
  })();
  console.log(
    "[ADVISOR]",
    "审核结果: " +
      (result.approved ? "通过" : "需修改") +
      " (" +
      provider +
      "/" +
      model +
      ")",
  );

  return { ...result, action };
}

/**
 * 检查系统升级需求（advisor 层）
 * @param {string} systemStatus - 系统状态报告
 * @param {Function} executeRequest - 执行请求的函数
 * @returns {{ met: boolean, task: string|null }}
 */
export async function checkUpgradeNeed(systemStatus, executeRequest) {
  const settings = await getSettings();
  if (settings.localFeaturesEnabled === false) {
    return { met: true, task: null, action: null };
  }

  const tiers = settings.advisorTiers || DEFAULT_ADVISOR_TIERS;

  for (const tier of tiers) {
    const allConnections = await getProviderConnections({ isActive: true });
    const connections = allConnections.filter((c) => {
      const prefix = c.providerSpecificData?.prefix || c.nodeName;
      return matchesAdvisorProvider(c, tier.provider);
    });
    const activeConnections = connections.filter(
      (c) => c.testStatus === "active" && c.apiKey,
    );

    if (activeConnections.length === 0) continue;

    for (const model of tier.models) {
      const usableConnection = activeConnections.find(
        (c) => !isModelLockActive(c, model),
      );
      if (!usableConnection) continue;

      try {
        console.log(
          "[ADVISOR]",
          "检查升级需求... (advisor: " +
            usableConnection.provider +
            "/" +
            model +
            ")",
        );

        const response = await executeRequest({
          provider: usableConnection.provider,
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: `系统状态: ${systemStatus}\n\n请检查当前配置是否需要升级。只输出 1（不需要）或具体建议。`,
            },
          ],
          max_tokens: 500,
        });

        const responseText = await readAdvisorText(response);
        const result = parseAdvisorResponse(responseText);
        const action = result.approved || !result.feedback ? null : (() => {
          const lower = result.feedback.toLowerCase();
          if (
            lower.includes("并发") ||
            lower.includes("concurrency") ||
            lower.includes("blast")
          ) {
            return { type: "increase_blast_concurrency", delta: 2 };
          }
          if (
            lower.includes("judge") ||
            lower.includes("评审") ||
            lower.includes("评分")
          ) {
            return { type: "enable_judge" };
          }
          if (
            lower.includes("切换") ||
            lower.includes("switch") ||
            lower.includes("tier")
          ) {
            return { type: "switch_advisor_tier" };
          }
          if (lower.includes("通知") || lower.includes("notify")) {
            return { type: "notify" };
          }
          return { type: "generic", task: result.feedback };
        })();
        console.log(
          "[ADVISOR]",
          "升级检查: " +
            (result.approved ? "达标" : "需升级") +
            " (" +
            usableConnection.provider +
            "/" +
            model +
            ")",
        );

        return {
          met: result.approved,
          task: result.feedback,
          action,
        };
      } catch (err) {
        console.log(
          "[ADVISOR]",
          "升级检查失败 (" +
            usableConnection.provider +
            "/" +
            model +
            "): " +
            err.message +
            "，尝试下一个...",
        );
        continue;
      }
    }
  }

  console.log("[ADVISOR]", "所有 advisor 层级均不可用");
  return {
    met: false,
    task: "所有 advisor 层级均不可用",
    action: { type: "notify" },
  };
}

/**
 * 追踪 advisor 用量 —— SQLite 持久化版
 * 解决 Next.js standalone 多 worker 进程 global 不共享问题
 */
export class AdvisorQuotaTracker {
  constructor() {
    this.dbPath = path.join(getDataDir(), "advisor_quota.sqlite");
    this._initDb();
  }

  _initDb() {
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS advisor_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hour TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ar_hour ON advisor_requests(hour);
      CREATE TABLE IF NOT EXISTS advisor_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this._checkpoint();
  }

  _checkpoint() {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
  }

  close() {
    if (this.db) {
      this._checkpoint();
      try {
        this.db.close();
      } catch {}
      this.db = null;
    }
  }

  recordRequest() {
    const hour = new Date().toISOString().slice(0, 13);
    const stmt = this.db.prepare(
      `INSERT INTO advisor_requests (hour, ts) VALUES (?, ?)`,
    );
    stmt.run(hour, Date.now());
    this._checkpoint();
  }

  checkHourlyQuota() {
    const hour = new Date().toISOString().slice(0, 13);
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM advisor_requests WHERE hour = ?`,
    );
    const row = stmt.get(hour);
    const count = row?.count ?? 0;
    return {
      count,
      met: count >= QUOTA_TARGET_PER_HOUR,
      target: QUOTA_TARGET_PER_HOUR,
    };
  }

  get sessionQuotaLocked() {
    const stmt = this.db.prepare(
      `SELECT value FROM advisor_meta WHERE key = 'locked'`,
    );
    const row = stmt.get();
    return row?.value === "1";
  }

  set sessionQuotaLocked(v) {
    const stmt = this.db.prepare(
      `INSERT INTO advisor_meta (key, value) VALUES ('locked', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    stmt.run(v ? "1" : "0");
    this._checkpoint();
  }

  async lockQuota(executeFn) {
    if (this.sessionQuotaLocked) return true;

    try {
      const result = await executeFn({
        provider: "nvidia",
        model: "free",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      });

      if (typeof result === "string") {
        this.sessionQuotaLocked = true;
        this.recordRequest();
        console.log("[ADVISOR_QUOTA]", "额度已占坑锁定");
        return true;
      }
    } catch (err) {
      console.log("[ADVISOR_QUOTA]", "占坑失败:", err.message);
    }
    return false;
  }

  getUpgradeTasksNeeded() {
    const { count, target } = this.checkHourlyQuota();
    return Math.max(0, target - count);
  }
}

export const advisorQuota = new AdvisorQuotaTracker();

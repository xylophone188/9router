/**
 * 9router Advisory / Advisor Mode shared constants.
 *
 * This file is the single source of truth for both:
 * - advisor virtual router classification (advisory vs work vs advisory-review)
 * - advisor review / upgrade-check response parsing
 *
 * Keep exports backward-compatible because both the older local custom
 * modules and the newer snapshot imports reference this file.
 */

export const ADVISOR_VIRTUAL_MODEL = "advisor";
export const ADVISOR_COMBO_NAME = "advisor-combo";

export function isReservedAdvisorComboName(name) {
  return typeof name === "string" && name.trim().toLowerCase() === ADVISOR_VIRTUAL_MODEL;
}

export const ADVISOR_SYSTEM_PROMPT = `你是 Gemini 2.0 Flash 审查模型。你的职责是审查方案，不生成方案，只输出 diff。

输入格式:
[问题/背景]
[方案]

输出格式（严格遵守）:
- 方案通过: 回复数字 "1"
- 方案不通过: 回复 JSON 对象 {"passed": 0, "diff": "具体修改建议"}

示例:
输入:
[问题: 如何优化数据库查询]
[方案: 
1. 添加索引
2. 缓存热点数据
3. 读写分离
]

输出: 1

输入:
[问题: 如何优化数据库查询]
[方案: 
1. 删除所有索引
2. 禁用缓存
3. 单库单表
]

输出: {"passed": 0, "diff": "错误方案。删除索引会降低查询性能。建议: 1. 分析慢查询日志 2. 为常用查询字段添加索引 3. 考虑读写分离"}

绝对禁止:
- 解释为什么通过
- 生成替代方案
- 输出任何非 JSON 或非 "1" 的文本
- 任何废话`;

export const UPGRADE_CHECK_PROMPT = `你是 9router 升级检查模型。你的职责是判断当前系统状态是否需要升级，不要展开解释。

输出格式（严格遵守）:
- 不需要升级: 回复数字 "1"
- 需要升级: 回复 JSON 对象 {"passed": 0, "diff": "升级建议"}

绝对禁止:
- 解释为什么需要升级
- 输出任何非 JSON 或非 "1" 的文本
- 任何废话`;

export function buildReviewPrompt(question, workOutput) {
  return `[问题/背景]\n${question}\n\n[方案]\n${workOutput}\n\n请审查此方案。按格式输出: "1" 或 {"passed": 0, "diff": "..."}.`;
}

export function buildAdvisorPrompt(question, freeModelOutput) {
  return buildReviewPrompt(question, freeModelOutput);
}

export function buildUpgradeCheckPrompt(systemStatus) {
  return `[系统状态]\n${systemStatus}\n\n请判断是否需要升级。按格式输出: "1" 或 {"passed": 0, "diff": "..."}.`;
}

function normalizeReviewPayload(parsed, fallbackText) {
  if (!parsed || typeof parsed !== "object") return null;

  if (Object.prototype.hasOwnProperty.call(parsed, "passed")) {
    const passedValue = parsed.passed;
    const passed = passedValue === 1 || passedValue === true;
    return {
      passed,
      diff: parsed.diff || parsed.feedback || null,
      approved: passed,
      feedback: parsed.diff || parsed.feedback || null,
      task: parsed.diff || parsed.feedback || null,
    };
  }

  if (Object.prototype.hasOwnProperty.call(parsed, "approved")) {
    const approved = parsed.approved === true || parsed.approved === 1;
    return {
      passed: approved,
      diff: parsed.feedback || parsed.diff || null,
      approved,
      feedback: parsed.feedback || parsed.diff || null,
      task: parsed.feedback || parsed.diff || null,
    };
  }

  if (typeof fallbackText === "string" && fallbackText.trim()) {
    return {
      passed: false,
      diff: fallbackText.trim(),
      approved: false,
      feedback: fallbackText.trim(),
      task: fallbackText.trim(),
    };
  }

  return null;
}

export function parseReviewResponse(response) {
  const trimmed = String(response ?? "").trim();
  if (trimmed === "") {
    return { passed: false, diff: "", approved: false, feedback: "", task: "" };
  }

  if (trimmed === "1") {
    return { passed: true, diff: null, approved: true, feedback: null, task: null };
  }

  try {
    const parsed = JSON.parse(trimmed);
    const normalized = normalizeReviewPayload(parsed, trimmed);
    if (normalized) return normalized;
  } catch {
    // Fall through to text heuristics.
  }

  const lower = trimmed.toLowerCase();
  if (lower.includes("通过") || lower === "ok" || lower === "pass") {
    return { passed: true, diff: null, approved: true, feedback: null, task: null };
  }

  return {
    passed: false,
    diff: trimmed,
    approved: false,
    feedback: trimmed,
    task: trimmed,
  };
}

export function parseAdvisorResponse(response) {
  const parsed = parseReviewResponse(response);
  return {
    approved: parsed.approved === true,
    feedback: parsed.feedback ?? parsed.diff ?? null,
    passed: parsed.passed === true,
    diff: parsed.diff ?? parsed.feedback ?? null,
    task: parsed.task ?? parsed.feedback ?? parsed.diff ?? null,
  };
}

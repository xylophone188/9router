/**
 * Advisor (virtual router) service.
 *
 * `model=advisor` is a virtual entry point. We do a fast/cheap intent
 * classification and route the request to either a high-intelligence combo
 * (advisory tasks) or a work/cheap combo (execution-heavy tasks).
 *
 * Classification happens in two stages:
 *   1. Fast rule-based classifier using keyword signals.
 *   2. Optional LLM classifier (non-streaming, cheap model) for low-confidence
 *      cases.
 *
 * Downstream execution reuses the normal combo / single-model routing, so
 * fallback / round-robin / race degrade naturally.
 */

/**
 * @typedef {object} IntentResult
 * @property {'advisory'|'work'} intent
 * @property {'high'|'medium'|'low'} confidence
 * @property {string} reason
 */

// Advisory signals: research, analysis, architecture, decision support
const ADVISORY_SIGNALS = [
  "研究", "分析", "方案", "架构", "设计", "对比", "评估",
  "research", "analyze", "architecture", "design", "compare",
  "best practice", "recommend", "strategy", "review",
  "有没有", "怎么实现", "哪个好", "推荐", "最佳实践",
  "思考", "讨论", "建议", "优化方案", "技术选型",
  "explain", "why", "how to", "what is", "difference",
  "论文", "paper", "理论", "原理", "deep dive",
  "规划", "roadmap", "vision", "mission",
];

// Work signals: implementation, coding, operations, bulk processing
const WORK_SIGNALS = [
  "写代码", "实现", "修复", "调试", "部署", "运行",
  "code", "implement", "fix", "debug", "deploy", "run",
  "build", "test", "refactor", "add feature", "update",
  "安装", "配置", "修改", "创建", "删除", "更新",
  "install", "configure", "modify", "create", "delete",
  "git", "commit", "push", "pull", "merge",
  "docker", "kubernetes", "sql", "query",
  "api", "endpoint", "function", "class",
  "脚本", "自动化", "批量", "数据处理",
];

const ADVISORY_WEIGHT = 2;
const WORK_WEIGHT = 2;
const CODE_BLOCK_BONUS = 3;
const TECH_INSTRUCTION_BONUS = 2;
const SHORT_QUESTION_BONUS = 1;

/**
 * Extract plain text from the last N user/assistant messages.
 * @param {Array<{role?:string, content?:string|object|Array}>} messages
 * @param {number} [limit=5]
 * @returns {string}
 */
export function extractRecentText(messages, limit = 5) {
  if (!Array.isArray(messages) || messages.length === 0) return "";

  const recent = messages.slice(-limit);
  const parts = [];

  for (const msg of recent) {
    if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;

    const content = msg.content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part.text === "string") {
          parts.push(part.text);
        }
      }
    } else if (content && typeof content.text === "string") {
      parts.push(content.text);
    }
  }

  return parts.join("\n").toLowerCase();
}

/**
 * Fast rule-based intent classifier.
 * @param {Array<{role?:string, content?:string|object|Array}>} messages
 * @returns {IntentResult}
 */
export function detectIntentByRules(messages) {
  const text = extractRecentText(messages, 5);

  if (!text.trim()) {
    return { intent: "advisory", confidence: "low", reason: "no readable text" };
  }

  let advisoryScore = 0;
  let workScore = 0;
  let matchedAdvisory = [];
  let matchedWork = [];

  for (const signal of ADVISORY_SIGNALS) {
    if (text.includes(signal.toLowerCase())) {
      advisoryScore += ADVISORY_WEIGHT;
      matchedAdvisory.push(signal);
    }
  }

  for (const signal of WORK_SIGNALS) {
    if (text.includes(signal.toLowerCase())) {
      workScore += WORK_WEIGHT;
      matchedWork.push(signal);
    }
  }

  // Code blocks strongly suggest implementation/work
  const codeBlockCount = (text.match(/```/g) || []).length;
  if (codeBlockCount >= 2) {
    workScore += CODE_BLOCK_BONUS;
  }

  // Long technical instructions -> work
  if (
    text.length > 500 &&
    (text.includes("npm") || text.includes("pip") || text.includes("cargo") || text.includes("docker"))
  ) {
    workScore += TECH_INSTRUCTION_BONUS;
  }

  // Short question -> advisory
  if (
    text.length < 200 &&
    (text.includes("?") || text.includes("？") || text.includes("什么") || text.includes("如何"))
  ) {
    advisoryScore += SHORT_QUESTION_BONUS;
  }

  // Advisory-review mode (work -> intelligence chain)
  const REVIEW_SIGNALS = [
    "审查", "审核", "评估", "diff", "修改建议",
    "review", "audit", "evaluate", "check",
    "是否正确", "对不对", "有没有问题", "是否可行",
  ];
  let reviewScore = 0;
  let matchedReview = [];
  for (const signal of REVIEW_SIGNALS) {
    if (text.includes(signal.toLowerCase())) {
      reviewScore += 2;
      matchedReview.push(signal);
    }
  }
  const reviewMargin = Math.abs(advisoryScore - reviewScore);
  if (reviewScore > advisoryScore && reviewMargin >= 2) {
    return {
      intent: "advisory-review",
      confidence: "high",
      reason: `review signals: ${matchedReview.slice(0, 4).join(", ")}`,
    };
  }

  const margin = Math.abs(advisoryScore - workScore);

  if (advisoryScore > workScore && margin >= 2) {
    return {
      intent: "advisory",
      confidence: "high",
      reason: `advisory signals: ${matchedAdvisory.slice(0, 4).join(", ")}`,
    };
  }

  if (workScore > advisoryScore && margin >= 2) {
    return {
      intent: "work",
      confidence: "high",
      reason: `work signals: ${matchedWork.slice(0, 4).join(", ")}${codeBlockCount >= 2 ? " + code blocks" : ""}`,
    };
  }

  // Tie or small margin -> low confidence, let LLM decide if enabled
  const intent = advisoryScore >= workScore ? "advisory" : "work";
  return {
    intent,
    confidence: "low",
    reason: `tie/weak signal (advisory=${advisoryScore}, work=${workScore})`,
  };
}

/**
 * Decide whether to invoke the LLM classifier based on rule confidence
 * and the configured threshold.
 * @param {IntentResult} ruleResult
 * @param {'rules-only'|'rules-first'|'always-llm'} threshold
 * @returns {boolean}
 */
export function shouldUseLlmClassifier(ruleResult, threshold) {
  if (threshold === "always-llm") return true;
  if (threshold === "rules-only") return false;
  // rules-first (default): only use LLM when confidence is low
  return ruleResult.confidence === "low";
}

/**
 * Build a non-streaming classifier request body.
 * @param {Array} messages
 * @param {string} classifierModel
 * @returns {object}
 */
export function buildClassifierBody(messages, classifierModel) {
  const userText = extractRecentText(messages, 5);

  const classifierMessages = [
    {
      role: "system",
      content:
        "You are a fast intent classifier. Given the user's request, decide whether it is primarily:\n" +
        "- 'advisory': needs high intelligence, research, analysis, architecture, decision support, explanation\n" +
        "- 'work': needs coding, implementation, fixing, deploying, running, bulk processing, data transformation\n" +
        "Respond ONLY with valid JSON: {\"intent\": \"advisory\" | \"work\", \"reason\": \"brief reason\"}",
    },
    {
      role: "user",
      content: userText || "(empty request)",
    },
  ];

  return {
    model: classifierModel,
    messages: classifierMessages,
    stream: false,
    max_tokens: 128,
    temperature: 0,
  };
}

/**
 * Extract the first assistant text from a non-streaming chat response.
 * Works with OpenAI-format JSON. SSE is parsed defensively.
 * @param {Response} response
 * @returns {Promise<string>}
 */
export async function extractClassifierText(response) {
  if (!response || !response.ok) {
    throw new Error(`classifier request failed: ${response?.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (contentType.includes("text/event-stream") || text.trim().startsWith("data:")) {
    // SSE: collect all delta.content fragments
    const chunks = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") break;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) chunks.push(delta.content);
        if (delta?.text) chunks.push(delta.text);
        // Anthropic-format
        if (parsed.delta?.text) chunks.push(parsed.delta.text);
      } catch {
        // ignore malformed SSE lines
      }
    }
    return chunks.join("");
  }

  // JSON
  try {
    const parsed = JSON.parse(text);
    const msg = parsed.choices?.[0]?.message;
    if (msg?.content) return msg.content;
    if (parsed.content) return parsed.content;
    return text;
  } catch {
    return text;
  }
}

/**
 * Parse classifier LLM output into a normalized intent.
 * @param {string} text
 * @returns {{intent:'advisory'|'work', reason:string}}
 */
export function parseClassifierResponse(text) {
  if (!text) return { intent: "advisory", reason: "empty classifier response" };

  const normalized = text.trim();

  // Try to extract JSON from markdown or raw text
  let jsonText = normalized;
  const codeBlockMatch = normalized.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonText = codeBlockMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonText);
    const intent = parsed.intent === "work" ? "work" : "advisory";
    return { intent, reason: String(parsed.reason || "llm classified") };
  } catch {
    // Fallback: only trust an explicit quoted intent value
    const lower = normalized.toLowerCase();
    const hasQuotedWork = lower.includes('"work"');
    const hasQuotedAdvisory = lower.includes('"advisory"');
    if (hasQuotedWork && !hasQuotedAdvisory) {
      return { intent: "work", reason: "keyword match in classifier output" };
    }
    return { intent: "advisory", reason: "could not parse classifier output, defaulting to advisory" };
  }
}

/**
 * Map classified intent to the configured target model/combo.
 * @param {'advisory'|'work'} intent
 * @param {object} settings
 * @returns {string}
 */
export function selectTargetModel(intent, settings) {
  if (intent === "work") {
    return settings.advisorWorkCombo || "work";
  }
  if (intent === "advisory-review") {
    return settings.advisorReviewCombo || "intelligence";
  }
  return settings.advisorHighCombo || "intelligence";
}

/**
 * Classify intent using rules and optionally an LLM classifier.
 *
 * @param {Array} messages - Original request messages
 * @param {object} settings - Settings including advisor* fields
 * @param {object} deps
 * @param {(body:object, model:string)=>Promise<Response>} deps.callClassifier
 *   Function that executes a single-model non-streaming chat request.
 * @returns {Promise<{intent:'advisory'|'work', reason:string, source:'rules'|'llm', targetModel:string}>}
 */
export async function classifyIntent(messages, settings, { callClassifier }) {
  const ruleResult = detectIntentByRules(messages);

  if (!settings.advisorEnabled) {
    // If somehow called while disabled, default to advisory combo
    return {
      intent: "advisory",
      reason: "advisor disabled",
      source: "rules",
      targetModel: selectTargetModel("advisory", settings),
    };
  }

  if (!shouldUseLlmClassifier(ruleResult, settings.advisorRuleThreshold)) {
    return {
      intent: ruleResult.intent,
      reason: ruleResult.reason,
      source: "rules",
      targetModel: selectTargetModel(ruleResult.intent, settings),
    };
  }

  // LLM classification path
  const classifierModel = settings.advisorClassifier || "local-llama/advisor";
  const classifierBody = buildClassifierBody(messages, classifierModel);

  try {
    const response = await callClassifier(classifierBody, classifierModel);
    const text = await extractClassifierText(response);
    const parsed = parseClassifierResponse(text);
    return {
      intent: parsed.intent,
      reason: parsed.reason,
      source: "llm",
      targetModel: selectTargetModel(parsed.intent, settings),
    };
  } catch (error) {
    // Conservative fallback: important requests go to high-intelligence combo
    return {
      intent: "advisory",
      reason: `classifier error: ${error.message}`,
      source: "llm",
      targetModel: selectTargetModel("advisory", settings),
    };
  }
}

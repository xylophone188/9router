import { describe, it, expect, vi } from "vitest";

import {
  extractRecentText,
  detectIntentByRules,
  shouldUseLlmClassifier,
  buildClassifierBody,
  parseClassifierResponse,
  selectTargetModel,
  classifyIntent,
  extractClassifierText,
} from "../../open-sse/services/advisor.js";
import { parseAdvisorResponse, parseReviewResponse, isReservedAdvisorComboName } from "../../src/shared/constants/advisorMode.js";

const DEFAULT_SETTINGS = {
  advisorEnabled: true,
  advisorClassifier: "local-llama/advisor",
  advisorHighCombo: "intelligence",
  advisorWorkCombo: "work",
  advisorRuleThreshold: "rules-first",
};

describe("advisor intent classification", () => {
  it("extracts text from string and array content", () => {
    const messages = [
      { role: "user", content: "Hello " },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
      { role: "user", content: { text: "how to design a cache?" } },
    ];
    expect(extractRecentText(messages)).toContain("how to design a cache?");
    expect(extractRecentText(messages)).toContain("hello");
  });

  it("classifies implementation requests as work", () => {
    const result = detectIntentByRules([
      { role: "user", content: "帮我写一段快速排序的代码并运行测试" },
    ]);
    expect(result.intent).toBe("work");
    expect(result.confidence).toBe("high");
  });

  it("classifies code blocks as work", () => {
    const result = detectIntentByRules([
      { role: "user", content: "```js\nconst x = 1;\n```\n修复这个 bug" },
    ]);
    expect(result.intent).toBe("work");
  });

  it("classifies research questions as advisory", () => {
    const result = detectIntentByRules([
      { role: "user", content: "分析一下不同向量数据库的优缺点，给一份技术选型方案" },
    ]);
    expect(result.intent).toBe("advisory");
    expect(result.confidence).toBe("high");
  });

  it("classifies short questions as advisory", () => {
    const result = detectIntentByRules([
      { role: "user", content: "什么是 prompt caching？" },
    ]);
    expect(result.intent).toBe("advisory");
  });

  it("returns low confidence for ambiguous inputs", () => {
    const result = detectIntentByRules([
      { role: "user", content: "ok" },
    ]);
    expect(result.confidence).toBe("low");
  });
});

describe("advisor threshold logic", () => {
  it("never uses LLM in rules-only mode", () => {
    expect(shouldUseLlmClassifier({ confidence: "low" }, "rules-only")).toBe(false);
  });

  it("always uses LLM in always-llm mode", () => {
    expect(shouldUseLlmClassifier({ confidence: "high" }, "always-llm")).toBe(true);
  });

  it("uses LLM only for low confidence in rules-first mode", () => {
    expect(shouldUseLlmClassifier({ confidence: "high" }, "rules-first")).toBe(false);
    expect(shouldUseLlmClassifier({ confidence: "medium" }, "rules-first")).toBe(false);
    expect(shouldUseLlmClassifier({ confidence: "low" }, "rules-first")).toBe(true);
  });
});

describe("advisor classifier body", () => {
  it("builds a non-streaming classifier request", () => {
    const body = buildClassifierBody([{ role: "user", content: "how to design a cache?" }], "local-llama/advisor");
    expect(body.model).toBe("local-llama/advisor");
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
  });
});

describe("advisor response parsing", () => {
  it("parses valid JSON intent", () => {
    const result = parseClassifierResponse('{"intent": "work", "reason": "coding task"}');
    expect(result.intent).toBe("work");
    expect(result.reason).toBe("coding task");
  });

  it("parses JSON inside markdown code block", () => {
    const result = parseClassifierResponse('```json\n{"intent": "advisory", "reason": "research"}\n```');
    expect(result.intent).toBe("advisory");
  });

  it("falls back to advisory on malformed output", () => {
    const result = parseClassifierResponse("I think this is work");
    expect(result.intent).toBe("advisory");
  });

  it("detects work from explicit quoted intent", () => {
    const result = parseClassifierResponse('The intent is "work" because it involves coding.');
    expect(result.intent).toBe("work");
  });

  it("extracts classifier text from OpenAI response JSON", async () => {
    const response = {
      ok: true,
      headers: new Map([["content-type", "application/json"]]),
      text: async () =>
        '{"choices":[{"message":{"content":"{\\"intent\\": \\"work\\", \\"reason\\": \\"coding\\"}"}}]}',
    };
    await expect(extractClassifierText(response)).resolves.toContain('"intent"');
  });
});

describe("advisor mode parsing", () => {
  it("trims modify and upgrade prefixes correctly", () => {
    const review = parseAdvisorResponse("修改建议: 请补充测试覆盖");
    expect(review.approved).toBe(false);
    expect(review.feedback).toBe("请补充测试覆盖");

    const upgrade = parseAdvisorResponse("升级任务: 增加并发");
    expect(upgrade.approved).toBe(false);
    expect(upgrade.feedback).toBe("增加并发");
  });

  it("treats advisor as a reserved combo name", () => {
    expect(isReservedAdvisorComboName("advisor")).toBe(true);
    expect(isReservedAdvisorComboName("advisor-combo")).toBe(false);
  });

  it("parses review JSON failure as failed", () => {
    const review = parseReviewResponse('{"passed":0,"diff":"fix it"}');
    expect(review.passed).toBe(false);
    expect(review.approved).toBe(false);
    expect(review.feedback).toBe("fix it");
  });

  it("parses review success token as passed", () => {
    const review = parseReviewResponse("1");
    expect(review.passed).toBe(true);
    expect(review.approved).toBe(true);
  });
});

describe("advisor target model selection", () => {
  it("maps advisory to high combo", () => {
    expect(selectTargetModel("advisory", DEFAULT_SETTINGS)).toBe("intelligence");
  });

  it("maps work to work combo", () => {
    expect(selectTargetModel("work", DEFAULT_SETTINGS)).toBe("work");
  });
});

describe("advisor classifyIntent integration", () => {
  it("returns rules result without calling LLM for high-confidence work", async () => {
    const callClassifier = vi.fn();
    const result = await classifyIntent(
      [{ role: "user", content: "实现一个 docker compose 文件" }],
      DEFAULT_SETTINGS,
      { callClassifier }
    );
    expect(result.source).toBe("rules");
    expect(result.intent).toBe("work");
    expect(result.targetModel).toBe("work");
    expect(callClassifier).not.toHaveBeenCalled();
  });

  it("calls LLM classifier for low-confidence input in rules-first mode", async () => {
    const callClassifier = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map().set("content-type", "application/json"),
      text: async () => '{"choices":[{"message":{"content":"{\\"intent\\": \\"advisory\\", \\"reason\\": \\"needs analysis\\"}"}}]}',
    });
    const result = await classifyIntent(
      [{ role: "user", content: "ok" }],
      DEFAULT_SETTINGS,
      { callClassifier }
    );
    expect(result.source).toBe("llm");
    expect(result.intent).toBe("advisory");
    expect(result.targetModel).toBe("intelligence");
    expect(callClassifier).toHaveBeenCalledTimes(1);
  });

  it("falls back to advisory combo on classifier error", async () => {
    const callClassifier = vi.fn().mockRejectedValue(new Error("timeout"));
    const result = await classifyIntent(
      [{ role: "user", content: "something vague" }],
      DEFAULT_SETTINGS,
      { callClassifier }
    );
    expect(result.intent).toBe("advisory");
    expect(result.targetModel).toBe("intelligence");
    expect(result.reason).toContain("timeout");
  });

  it("falls back to advisory combo when classifier is unavailable", async () => {
    const callClassifier = vi.fn();
    const result = await classifyIntent(
      [{ role: "user", content: "ok" }],
      DEFAULT_SETTINGS,
      {
        callClassifier,
        isClassifierAvailable: async () => false,
      }
    );
    expect(result.source).toBe("rules");
    expect(result.intent).toBe("advisory");
    expect(callClassifier).not.toHaveBeenCalled();
  });

  it("always calls LLM in always-llm mode", async () => {
    const callClassifier = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map().set("content-type", "application/json"),
      text: async () => '{"choices":[{"message":{"content":"{\\"intent\\": \\"work\\", \\"reason\\": \\"coding\\"}"}}]}',
    });
    const result = await classifyIntent(
      [{ role: "user", content: "分析一下这个架构" }],
      { ...DEFAULT_SETTINGS, advisorRuleThreshold: "always-llm" },
      { callClassifier }
    );
    expect(result.source).toBe("llm");
    expect(callClassifier).toHaveBeenCalledTimes(1);
  });
});

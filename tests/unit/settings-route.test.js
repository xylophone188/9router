import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  applyOutboundProxyEnv: vi.fn(),
  resetComboRotation: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init = {}) => ({ body, status: init.status || 200 })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));

vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: mocks.applyOutboundProxyEnv,
}));

vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: mocks.resetComboRotation,
}));

vi.mock("bcryptjs", () => ({
  default: {
    genSalt: vi.fn(),
    hash: vi.fn(),
    compare: vi.fn(),
  },
}));

const { GET, PATCH } = await import("../../src/app/api/settings/route.js");

function request(body) {
  return {
    json: async () => body,
  };
}

describe("settings route local feature gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves local feature fields when localFeaturesEnabled is turned off", async () => {
    mocks.getSettings.mockResolvedValue({
      localFeaturesEnabled: true,
      advisorEnabled: true,
      advisorClassifier: "local-llama/advisor",
      advisorHighCombo: "intelligence",
      advisorWorkCombo: "work",
      advisorReviewCombo: "intelligence",
      advisorRuleThreshold: "rules-first",
      forceAdvisorRouting: true,
      advisorTiers: [{ provider: "claude", models: ["claude-opus-4-8"] }],
      blastMaxModels: 4,
      blastTimeoutMs: 1234,
      blastBatchSize: 2,
      blastBatchDelay: 3,
      blastJudgeEnabled: true,
      blastJudgeProvider: "anthropic",
      blastJudgeModel: "claude-sonnet-4-20250514",
      blastTopN: 2,
      quotaWarmUpEnabled: true,
      quotaWarmUpProvider: "anthropic",
      quotaWarmUpModel: "claude-sonnet-4-20250514",
      quotaWarmUpThresholdPercent: 25,
      quotaWarmUpMinHours: 5,
      rtkEnabled: true,
      cavemanEnabled: false,
    });
    mocks.updateSettings.mockResolvedValue({
      localFeaturesEnabled: false,
      advisorEnabled: true,
      advisorClassifier: "local-llama/advisor",
      rtkEnabled: true,
      cavemanEnabled: false,
    });

    const res = await PATCH(request({ localFeaturesEnabled: false }));

    expect(mocks.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      localFeaturesEnabled: false,
      advisorEnabled: true,
      advisorClassifier: "local-llama/advisor",
      advisorHighCombo: "intelligence",
      advisorWorkCombo: "work",
      advisorReviewCombo: "intelligence",
      advisorRuleThreshold: "rules-first",
      forceAdvisorRouting: true,
      advisorTiers: [{ provider: "claude", models: ["claude-opus-4-8"] }],
      blastMaxModels: 4,
      blastTimeoutMs: 1234,
      blastBatchSize: 2,
      blastBatchDelay: 3,
      blastJudgeEnabled: true,
      blastJudgeProvider: "anthropic",
      blastJudgeModel: "claude-sonnet-4-20250514",
      blastTopN: 2,
      quotaWarmUpEnabled: true,
      quotaWarmUpProvider: "anthropic",
      quotaWarmUpModel: "claude-sonnet-4-20250514",
      quotaWarmUpThresholdPercent: 25,
      quotaWarmUpMinHours: 5,
    }));
    expect(mocks.applyOutboundProxyEnv).not.toHaveBeenCalled();
    expect(mocks.resetComboRotation).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});

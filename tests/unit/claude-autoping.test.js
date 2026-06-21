import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getClaudeUsage: vi.fn(),
  proxyAwareFetch: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  refreshAndUpdateCredentials: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("open-sse/index.js", () => ({}), { virtual: true });

vi.mock("open-sse/providers/shared.js", () => ({
  CLAUDE_CLI_SPOOF_HEADERS: {},
}), { virtual: true });

vi.mock("@/shared/constants/config", () => ({
  CLAUDE_AUTOPING_CONFIG: {
    settingsKey: "claudeAutoPing",
    tickIntervalMs: 60000,
    pingLeadMs: 5000,
    pingModel: "claude-haiku-4-5-20251001",
    pingText: "hi",
    pingMaxTokens: 1,
    refreshAheadMs: 300000,
    fiveHourKey: "session (5h)",
  },
}), { virtual: true });

vi.mock("open-sse/services/usage/claude.js", () => ({
  getClaudeUsage: mocks.getClaudeUsage,
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: mocks.refreshAndUpdateCredentials,
}));

const { __test__ } = await import("../../src/shared/services/claudeAutoPing.js");

describe("Claude auto-ping master switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not run when localFeaturesEnabled is false", async () => {
    mocks.getSettings.mockResolvedValue({
      localFeaturesEnabled: false,
      claudeAutoPing: { connections: { conn1: true } },
    });

    await __test__.tick();

    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
    expect(mocks.getClaudeUsage).not.toHaveBeenCalled();
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });
});

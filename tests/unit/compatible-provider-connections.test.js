import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setupTestContext(nodeData) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-compatible-provider-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));

  const { POST } = await import("@/app/api/providers/route.js");
  const {
    createProviderNode,
    getProviderConnections,
  } = await import("@/models/index.js");

  const node = await createProviderNode(nodeData);

  return {
    node,
    POST,
    getProviderConnections,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function makeRequest(provider) {
  return new Request("https://9router.local/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider,
      apiKey: "test-key",
      name: "Test Connection",
      defaultModel: "test-model",
    }),
  });
}

function expectCompatibleConnection(connection, node, { apiType } = {}) {
  expect(connection.provider).toBe(node.id);
  expect(connection.authType).toBe("apikey");
  expect(connection.defaultModel).toBe("test-model");
  expect(connection.providerSpecificData).toMatchObject({
    prefix: node.prefix,
    baseUrl: node.baseUrl,
    nodeName: node.name,
  });

  if (apiType !== undefined) {
    expect(connection.providerSpecificData.apiType).toBe(apiType);
  }
}

describe("compatible provider connections API", () => {
  let cleanup = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    vi.clearAllMocks();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("creates one API-key connection for an OpenAI-compatible node", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-test",
      type: "openai-compatible",
      name: "OpenAI Compatible Test Node",
      prefix: "oct",
      apiType: "chat",
      baseUrl: "https://openai-compatible.test/v1",
    });
    cleanup = ctx.cleanup;

    const response = await ctx.POST(makeRequest(ctx.node.id));
    const body = await response.json();
    const connection = body.connection;
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(response.status).toBe(201);
    expect(storedConnections).toHaveLength(1);
    expectCompatibleConnection(connection, ctx.node, { apiType: "chat" });
    expect(storedConnections[0]).toMatchObject({
      provider: ctx.node.id,
      authType: "apikey",
      defaultModel: "test-model",
      providerSpecificData: {
        prefix: ctx.node.prefix,
        apiType: "chat",
        baseUrl: ctx.node.baseUrl,
        nodeName: ctx.node.name,
      },
    });
  });

  it("creates one API-key connection for an Anthropic-compatible node", async () => {
    const ctx = await setupTestContext({
      id: "anthropic-compatible-test",
      type: "anthropic-compatible",
      name: "Anthropic Compatible Test Node",
      prefix: "act",
      baseUrl: "https://anthropic-compatible.test/v1",
    });
    cleanup = ctx.cleanup;

    const response = await ctx.POST(makeRequest(ctx.node.id));
    const body = await response.json();
    const connection = body.connection;
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(response.status).toBe(201);
    expect(storedConnections).toHaveLength(1);
    expectCompatibleConnection(connection, ctx.node);
    expect(storedConnections[0]).toMatchObject({
      provider: ctx.node.id,
      authType: "apikey",
      defaultModel: "test-model",
      providerSpecificData: {
        prefix: ctx.node.prefix,
        baseUrl: ctx.node.baseUrl,
        nodeName: ctx.node.name,
      },
    });
  });

  it("allows multiple connections on the same compatible node", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-multi",
      type: "openai-compatible",
      name: "Multi Connection Test Node",
      prefix: "mct",
      apiType: "chat",
      baseUrl: "https://multi.test/v1",
    });
    cleanup = ctx.cleanup;

    // First connection
    const response1 = await ctx.POST(makeRequest(ctx.node.id));
    const body1 = await response1.json();
    expect(response1.status).toBe(201);

    // Second connection should also succeed
    const request2 = new Request("https://9router.local/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: ctx.node.id,
        apiKey: "sk-second-test-key",
        name: "Second Connection",
        defaultModel: "test-model",
      }),
    });
    const response2 = await ctx.POST(request2);
    const body2 = await response2.json();
    expect(response2.status).toBe(201);

    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });
    expect(storedConnections).toHaveLength(2);
  });;
});

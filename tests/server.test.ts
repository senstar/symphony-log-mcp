import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, setLogDir, getCurrentLogDir } from "../src/server.js";
import { TOOLS } from "../src/tool-registry.js";
import { DOMAIN_KNOWLEDGE } from "../src/lib/domain-knowledge.js";
import { createTestLogDir, type TestLogDir } from "./test-helpers.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---- Mock dispatchToolCall so non-sym_open tools don't need real log files ----
vi.mock("../src/tool-dispatch.js", () => ({
  dispatchToolCall: vi.fn(async (name: string) => `mock-result-for-${name}`),
}));

import { dispatchToolCall } from "../src/tool-dispatch.js";
const mockDispatch = vi.mocked(dispatchToolCall);

// ---- Capture request handlers registered by createServer() ----
type HandlerFn = (request: any) => Promise<any>;
const handlers = new Map<any, HandlerFn>();

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => {
  class FakeServer {
    constructor(public info: any, public opts: any) {}
    setRequestHandler(schema: any, handler: HandlerFn) {
      handlers.set(schema, handler);
    }
  }
  return { Server: FakeServer };
});

/** Helper to invoke a captured handler by schema */
function callHandler(schema: any, params: Record<string, unknown>) {
  const handler = handlers.get(schema);
  if (!handler) throw new Error(`No handler registered for schema`);
  return handler({ params });
}

// ---- Tests ----

describe("server", () => {
  let testLogDir: TestLogDir | null = null;

  beforeEach(() => {
    handlers.clear();
    mockDispatch.mockClear();
    // Reset module-level state by setting to null-ish via env trick
    // We'll use setLogDir / direct calls instead
  });

  afterEach(async () => {
    if (testLogDir) {
      await testLogDir.cleanup();
      testLogDir = null;
    }
  });

  // ---- 1. createServer() returns a Server instance ----
  it("createServer returns a server object", () => {
    const server = createServer();
    expect(server).toBeDefined();
    expect(typeof server).toBe("object");
  });

  // ---- 2. setLogDir / getCurrentLogDir round-trip ----
  it("setLogDir / getCurrentLogDir round-trip", () => {
    setLogDir("C:\\Test\\Logs");
    expect(getCurrentLogDir()).toBe("C:\\Test\\Logs");
  });

  // ---- 3. ListToolsRequestSchema returns TOOLS ----
  it("ListToolsRequestSchema handler returns the TOOLS array", async () => {
    createServer();
    const result = await callHandler(ListToolsRequestSchema, {});
    expect(result).toEqual({ tools: TOOLS });
  });

  // ---- 4. ListResourcesRequestSchema returns domain-knowledge resource ----
  it("ListResourcesRequestSchema handler returns domain-knowledge resource", async () => {
    createServer();
    const result = await callHandler(ListResourcesRequestSchema, {});
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].uri).toBe("symphony://domain-knowledge");
    expect(result.resources[0].name).toBe("Symphony VMS Domain Knowledge");
  });

  // ---- 5. ReadResourceRequestSchema for domain-knowledge returns DOMAIN_KNOWLEDGE ----
  it("ReadResourceRequestSchema returns DOMAIN_KNOWLEDGE for symphony://domain-knowledge", async () => {
    createServer();
    const result = await callHandler(ReadResourceRequestSchema, {
      uri: "symphony://domain-knowledge",
    });
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].uri).toBe("symphony://domain-knowledge");
    expect(result.contents[0].text).toBe(DOMAIN_KNOWLEDGE);
    expect(result.contents[0].mimeType).toBe("text/markdown");
  });

  // ---- 6. ReadResourceRequestSchema for unknown URI throws ----
  it("ReadResourceRequestSchema throws for unknown URI", async () => {
    createServer();
    await expect(
      callHandler(ReadResourceRequestSchema, { uri: "symphony://unknown" })
    ).rejects.toThrow("Unknown resource: symphony://unknown");
  });

  // ---- 7. sym_open with valid dir sets the log directory ----
  it("sym_open with valid dir sets the log directory", async () => {
    testLogDir = await createTestLogDir();
    createServer();

    const result = await callHandler(CallToolRequestSchema, {
      name: "sym_open",
      arguments: { logDir: testLogDir.dir },
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Opened");
    expect(getCurrentLogDir()).toBe(testLogDir.dir);
  });

  // ---- 8. sym_open with nonexistent dir returns error ----
  it("sym_open with nonexistent dir returns error", async () => {
    createServer();

    const result = await callHandler(CallToolRequestSchema, {
      name: "sym_open",
      arguments: { logDir: "Z:\\nonexistent\\path\\that\\does\\not\\exist" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not exist");
  });

  // ---- 9. sym_open with empty dir and no current log dir returns error ----
  it("sym_open with empty dir and no current log dir returns error", async () => {
    // _currentLogDir must be falsy so the no-arg path returns an error.
    // setLogDir casts directly, and "" is falsy in the `if (_currentLogDir)` check.
    setLogDir("" as any);

    createServer();

    const result = await callHandler(CallToolRequestSchema, {
      name: "sym_open",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("logDir parameter is required");
  });

  // ---- 10. sym_open with empty dir but existing log dir returns current dir ----
  it("sym_open with no dir returns current log dir when one is set", async () => {
    testLogDir = await createTestLogDir();
    setLogDir(testLogDir.dir);
    createServer();

    const result = await callHandler(CallToolRequestSchema, {
      name: "sym_open",
      arguments: {},
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(`Current log directory: ${testLogDir.dir}`);
  });

  // ---- 11. Non-sym_open tool dispatches to dispatchToolCall ----
  it("non-sym_open tool dispatches to dispatchToolCall", async () => {
    testLogDir = await createTestLogDir();
    setLogDir(testLogDir.dir);
    createServer();

    const result = await callHandler(CallToolRequestSchema, {
      name: "sym_triage",
      arguments: {},
    });

    expect(mockDispatch).toHaveBeenCalledOnce();
    expect(mockDispatch.mock.calls[0][0]).toBe("sym_triage");
    expect(result.content[0].text).toBe("mock-result-for-sym_triage");
  });

  // ---- 12. Error from tool is wrapped in isError response ----
  it("error from tool call is wrapped in isError response", async () => {
    testLogDir = await createTestLogDir();
    setLogDir(testLogDir.dir);
    mockDispatch.mockRejectedValueOnce(new Error("something broke"));
    createServer();

    const result = await callHandler(CallToolRequestSchema, {
      name: "sym_triage",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("something broke");
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  profileAwareToolServer,
  type SupervisedToolFacadeDependencies,
} from "../server/supervised-tool-facade.js";

const result = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

function registeredHandler(dependencies: SupervisedToolFacadeDependencies, callback: () => Promise<CallToolResult>) {
  let handler: ((input: unknown, extra: { requestId?: string }) => Promise<CallToolResult>) | null = null;
  const server = {
    tool(_name: string, ...registration: unknown[]) {
      handler = registration.at(-1) as typeof handler;
      return {};
    },
  } as unknown as McpServer;
  const facade = profileAwareToolServer(server, "supervised_room_turn", dependencies);
  (facade.tool as (...args: unknown[]) => unknown)("send_message", "description", {}, callback);
  assert.ok(handler);
  return handler;
}

test("supervised effects refuse a missing MCP request id before preparation", async () => {
  let prepared = false;
  const handler = registeredHandler({
    prepareEffect: async () => { prepared = true; throw new Error("not reached"); },
    completeEffect: async () => {},
  }, async () => result("not reached"));
  await assert.rejects(() => handler({}, {}), /missing its MCP request id/);
  assert.equal(prepared, false);
});

test("completion transport failure never rewrites a successful callback as failed", async () => {
  let callbackCount = 0;
  const completions: Array<{ result?: unknown; error?: string }> = [];
  const handler = registeredHandler({
    prepareEffect: async () => ({ state: "prepared", effectId: "effect_exact", action: "execute" }),
    completeEffect: async (completion) => {
      completions.push(completion);
      throw new Error("completion socket unavailable");
    },
  }, async () => { callbackCount += 1; return result("sent once"); });
  await assert.rejects(() => handler({}, { requestId: "request_exact" }), /completion socket unavailable/);
  assert.equal(callbackCount, 1);
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.error, undefined);
  assert.deepEqual(completions[0]?.result, result("sent once"));
});

test("failure-reporting errors do not mask the original callback error", async () => {
  const handler = registeredHandler({
    prepareEffect: async () => ({ state: "prepared", effectId: "effect_failed", action: "execute" }),
    completeEffect: async () => { throw new Error("journal unavailable"); },
  }, async () => { throw new Error("tool failed first"); });
  await assert.rejects(() => handler({}, { requestId: "request_failed" }), /tool failed first/);
});

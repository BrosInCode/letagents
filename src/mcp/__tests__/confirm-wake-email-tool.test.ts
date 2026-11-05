import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// The `confirm_wake_email` tool as the npm package wires it: one `code` input,
// one POST to the API, the server's refusal passed through as it was answered.
const tempDir = mkdtempSync(join(tmpdir(), "letagents-confirm-wake-email-"));
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_API_URL = "http://127.0.0.1:39999";
process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");
process.env.LETAGENTS_CHAT_STORAGE = "cloud";
process.env.LETAGENTS_TOKEN = "owner-token";
delete process.env.LETAGENTS_AGENT_SESSION_BEARER;

const originalFetch = globalThis.fetch;
const { registerWakeRuleTools } = await import("../server/tools/wake-rules.js");
const { REMOTE_ALLOWED_TOOLS } = await import("../server/remote-tool-surface.js");
const { SUPERVISED_READ_ONLY_TOOLS } = await import("../../../shared/supervised-read-tools.mjs");

test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

type Handler = (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function registered(name: string): { handler: Handler; description: string; schema: Record<string, unknown> } {
  let found: { handler: Handler; description: string; schema: Record<string, unknown> } | null = null;
  registerWakeRuleTools({ tool(toolName: string, description: string, schema: Record<string, unknown>, callback: unknown) {
    if (toolName === name) found = { handler: callback as Handler, description, schema };
  } } as unknown as McpServer);
  assert.ok(found, `missing ${name}`);
  return found;
}

async function answer(handler: Handler, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return JSON.parse((await handler(input)).content[0]!.text) as Record<string, unknown>;
}

const CODE = "a".repeat(64);
const RULE = { id: "wake_9", status: "active", event: "room.message", delivery: { kind: "email", paused: false } };

/** An API that answers the confirm route with one fixed answer and records what it was asked. */
function fakeApi(status: number, body: unknown): Array<{ method: string; path: string; body: unknown; authorization: string | null }> {
  const requests: Array<{ method: string; path: string; body: unknown; authorization: string | null }> = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const headers = new Headers(init?.headers);
    requests.push({
      method: init?.method ?? "GET", path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      authorization: headers.get("Authorization"),
    });
    if (path === "/agents/me") return new Response(JSON.stringify({ account: { id: "acct", login: "ada" }, agents: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/wake-rules/confirm") return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ error: `unexpected ${path}` }), { status: 404 });
  };
  return requests;
}

test("confirm_wake_email takes one code, says what it answers, and is offered to remote bots as a mutation", () => {
  const { description, schema } = registered("confirm_wake_email");
  assert.deepEqual(Object.keys(schema), ["code"], "the code names the rule; no room or worker is needed");
  assert.match(description, /"Confirmation code: <code>"/);
  assert.match(description, /same single-use value as the mail's link/);
  assert.match(description, /unknown_or_expired/);
  assert.match(description, /not_yours, already_active or too_many_attempts \(10 attempts per 10 minutes\)/);
  assert.ok(REMOTE_ALLOWED_TOOLS.includes("confirm_wake_email"), "Grok Bot and ChatGPT reach the tool over /mcp");
  assert.equal(SUPERVISED_READ_ONLY_TOOLS.has("confirm_wake_email"), false, "confirming is a write, journaled when supervised");
});

test("the handler posts the code to /wake-rules/confirm as the signed-in account and returns the confirmed rule", async () => {
  const requests = fakeApi(200, { confirmed: true, rule: RULE });
  const { handler } = registered("confirm_wake_email");
  const result = await answer(handler, { code: CODE });
  assert.deepEqual(result, { confirmed: true, rule: RULE });
  const confirm = requests.filter((request) => request.path === "/wake-rules/confirm");
  assert.deepEqual(confirm.map((request) => [request.method, request.body]), [["POST", { code: CODE }]]);
  assert.equal(confirm[0]!.authorization, "Bearer owner-token", "the owner token is the credential the rule's owner check and the attempt budget see");
});

test("a refusal is passed through as the server answered it; any other failure is an error result", async () => {
  const { handler } = registered("confirm_wake_email");
  fakeApi(403, { confirmed: false, error: "not_yours", message: "This code belongs to an email rule of another account's agent. Nothing changed." });
  assert.deepEqual(await answer(handler, { code: CODE }), {
    confirmed: false, error: "not_yours", message: "This code belongs to an email rule of another account's agent. Nothing changed.",
  });
  fakeApi(429, { confirmed: false, error: "too_many_attempts", message: "Wait." });
  assert.equal((await answer(handler, { code: CODE })).error, "too_many_attempts");
  fakeApi(409, { confirmed: false, error: "already_active", message: "Nothing changed.", rule: RULE });
  assert.deepEqual((await answer(handler, { code: CODE })).rule, RULE);
  fakeApi(500, { error: "Unable to save or load wake rules. Please retry." });
  const failed = await answer(handler, { code: CODE });
  assert.equal(failed.success, false);
  assert.match(String(failed.error), /API error 500/);
});

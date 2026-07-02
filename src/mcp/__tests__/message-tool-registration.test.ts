import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMessageTools, registerStatusTools } from "../server/tools/messages.js";
import { buildSendMessageRequestBody } from "../server/tools/messages/send-tool.js";

type ToolRegistration = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: unknown;
};

function collectMessageToolRegistrations(): ToolRegistration[] {
  const registrations: ToolRegistration[] = [];
  const server = {
    tool(name: string, description: string, schema: Record<string, unknown>, handler: unknown) {
      registrations.push({ name, description, schema, handler });
    },
  };

  registerStatusTools(server as unknown as McpServer);
  registerMessageTools(server as unknown as McpServer);
  return registrations;
}

test("message and status tool registration preserves the public surface", () => {
  const registrations = collectMessageToolRegistrations();

  assert.deepEqual(registrations.map((registration) => registration.name), [
    "post_status",
    "post_reasoning",
    "send_message",
    "send_thread_message",
    "read_messages",
    "wait_for_messages",
  ]);
  assert.ok(registrations.every((registration) => typeof registration.handler === "function"));
});

test("worker-facing message tools keep registered worker-session inputs", () => {
  const registrations = collectMessageToolRegistrations();
  const workerToolNames = new Set([
    "post_status",
    "post_reasoning",
    "send_message",
    "send_thread_message",
    "wait_for_messages",
  ]);

  for (const registration of registrations) {
    assert.ok("room_id" in registration.schema, `${registration.name} should accept room_id`);
    if (!workerToolNames.has(registration.name)) continue;

    assert.ok("agent_session_id" in registration.schema, `${registration.name} should accept agent_session_id`);
  }
});

test("thread-capable message tools expose thread parent inputs", () => {
  const registrations = collectMessageToolRegistrations();
  const sendMessage = registrations.find((registration) => registration.name === "send_message");
  const sendThreadMessage = registrations.find((registration) => registration.name === "send_thread_message");

  assert.ok(sendMessage, "send_message should be registered");
  assert.ok(sendThreadMessage, "send_thread_message should be registered");
  assert.ok("thread_parent_id" in sendMessage.schema, "send_message should accept thread_parent_id");
  assert.ok("thread_parent_id" in sendThreadMessage.schema, "send_thread_message should require thread_parent_id");
  assert.match(sendMessage.description, /thread/i);
  assert.match(sendThreadMessage.description, /thread/i);
});

test("thread-parent sends include explicit thread root in the remote post body", () => {
  const body = buildSendMessageRequestBody({
    sender: "CedarVista | EmmyMay's agent | Agent",
    text: "continuing the thread",
    replyTarget: "msg_7",
    resolvedThreadRoot: "msg_1",
    credentials: {
      agent_session_id: "agent_session_1",
      agent_session_token: "token_1",
    },
  });

  assert.deepEqual(body, {
    sender: "CedarVista | EmmyMay's agent | Agent",
    text: "continuing the thread",
    reply_to: "msg_7",
    thread_root_id: "msg_1",
    agent_session_id: "agent_session_1",
    agent_session_token: "token_1",
  });
});

test("legacy quote replies stay free of thread_root_id in the remote post body", () => {
  const body = buildSendMessageRequestBody({
    sender: "CedarVista | EmmyMay's agent | Agent",
    text: "quote reply",
    replyTarget: "msg_7",
    credentials: {
      agent_session_id: "agent_session_1",
      agent_session_token: "token_1",
    },
  });

  assert.equal(body.reply_to, "msg_7");
  assert.equal("thread_root_id" in body, false);
});

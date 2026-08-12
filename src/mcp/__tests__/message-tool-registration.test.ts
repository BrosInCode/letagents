import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMessageTools, registerStatusTools } from "../server/tools/messages.js";
import { buildSendMessageRequestBody } from "../server/tools/messages/send-tool.js";
import {
  DEFAULT_WAIT_CATCHUP_LIMIT,
  buildWaitForMessagesRequestOptions,
  filterSilentActivationMessages,
  planWaitForMessagesFetch,
  resolveEffectiveAfterMessageId,
} from "../server/tools/messages/wait-tool.js";
import {
  LETAGENTS_AGENT_SESSION_ID_HEADER,
  LETAGENTS_AGENT_SESSION_TOKEN_HEADER,
} from "../../shared/request-headers.js";

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

test("wait_for_messages remote requests preserve worker delivery headers", () => {
  const deliveryHeaders = {
    [LETAGENTS_AGENT_SESSION_ID_HEADER]: "agent_session_1",
    [LETAGENTS_AGENT_SESSION_TOKEN_HEADER]: "token_1",
  };
  const signal = AbortSignal.timeout(1000);

  assert.deepEqual(
    buildWaitForMessagesRequestOptions({ deliveryHeaders, signal }),
    {
      headers: deliveryHeaders,
      signal,
    },
  );

  assert.deepEqual(
    buildWaitForMessagesRequestOptions({ deliveryHeaders }),
    {
      headers: deliveryHeaders,
    },
  );
});

test("wait_for_messages filters silent activation messages without losing cursor progress", () => {
  const result = filterSilentActivationMessages([
    {
      id: "msg_1",
      text: "@NorthHarbor please review",
      activation: {
        for_current_agent: {
          decision: "silent",
          reason: "explicit_other_mention",
          addressed: false,
        },
      },
    },
    {
      id: "msg_2",
      text: "general update",
      activation: {
        for_current_agent: {
          decision: "unclear",
          reason: "unaddressed",
          addressed: false,
        },
      },
    },
    {
      id: "msg_3",
      text: "own echo",
      activation: {
        for_current_agent: {
          decision: "silent",
          reason: "self_message",
          addressed: false,
        },
      },
    },
  ]);

  assert.deepEqual(result.messages.map((message) => message.id), ["msg_2"]);
  assert.deepEqual(result.skipped_message_ids, ["msg_1", "msg_3"]);
  assert.equal(result.last_observed_message_id, "msg_3");
});

test("wait_for_messages catches up on a bounded recent tail when no cursor is given", () => {
  const plan = planWaitForMessagesFetch({ effectiveAfterMessageId: undefined });

  assert.deepEqual(plan, { mode: "catch_up_tail", limit: DEFAULT_WAIT_CATCHUP_LIMIT });
  // The bound must be finite and small so a no-cursor call never replays the
  // entire room history (the multi-MB busy-room bug this fix addresses).
  assert.ok(plan.mode === "catch_up_tail" && plan.limit > 0 && plan.limit <= 500);
});

test("wait_for_messages respects an explicit catch-up limit override", () => {
  const plan = planWaitForMessagesFetch({ effectiveAfterMessageId: undefined, catchupLimit: 25 });

  assert.deepEqual(plan, { mode: "catch_up_tail", limit: 25 });
});

test("wait_for_messages keeps cursor semantics while response paging stays bounded", () => {
  const plan = planWaitForMessagesFetch({ effectiveAfterMessageId: "msg_42" });

  // The cursor is preserved; the runtime returns one bounded page and exposes
  // last_observed_message_id/truncated so the next call resumes safely.
  assert.deepEqual(plan, { mode: "after_cursor", after: "msg_42" });
});

test("wait_for_messages description no longer promises the full history on a no-cursor call", () => {
  const registrations = collectMessageToolRegistrations();
  const wait = registrations.find((registration) => registration.name === "wait_for_messages");

  assert.ok(wait, "wait_for_messages should be registered");
  const afterField = (wait.schema as { after_message_id?: { description?: string } }).after_message_id;
  const description = afterField?.description ?? "";
  assert.doesNotMatch(description, /all existing messages/i);
  assert.match(description, /most recent/i);
});

test("wait_for_messages honors explicit cursors instead of forcing stored progress", () => {
  assert.equal(
    resolveEffectiveAfterMessageId({
      requestedAfterMessageId: "msg_1",
      rememberedLastMessageId: "msg_3",
    }),
    "msg_1",
  );

  assert.equal(
    resolveEffectiveAfterMessageId({
      requestedAfterMessageId: "msg_4",
      rememberedLastMessageId: "msg_3",
    }),
    "msg_4",
  );

  assert.equal(
    resolveEffectiveAfterMessageId({
      requestedAfterMessageId: undefined,
      rememberedLastMessageId: "msg_3",
    }),
    undefined,
  );
});

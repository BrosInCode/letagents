import assert from "node:assert/strict";
import test from "node:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  profileAwareToolServer,
  type SupervisedToolFacadeDependencies,
} from "../server/supervised-tool-facade.js";
import {
  getCurrentSupervisedRoomAuthority,
  runWithSupervisedRoomAuthority,
} from "../server/runtime/supervised-room-authority.js";

const result = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });
const waitResult = (data: Record<string, unknown> = {}): CallToolResult => result(JSON.stringify({ messages: [], ...data }));
const withRoom = <T>(roomId: string, callback: () => T): T => runWithSupervisedRoomAuthority(roomId, callback);

test("custodial tools gate before work and fence read release without bounded effects", async () => {
  for (const tool of ["send_message", "read_messages", "wait_for_messages"]) {
    for (const rejectAt of ["before", "release", "never"]) {
      const phases: string[] = [];
      let calls = 0;
      const authority = { roomId: "room_exact", agentSessionId: "session_exact", roomCursor: "msg_7", configurationRevision: 3 } as import("../server/runtime/supervisor-bridge.js").CustodialPollingAuthorization;
      const handler = registeredHandler({
        authorizePolling: async (_name, prior) => {
          const phase = prior ? "release" : "before";
          phases.push(phase);
          if (prior) assert.equal(prior, authority, "release must retain its before snapshot");
          if (phase === rejectAt) throw new Error("stale authority");
          return authority;
        },
        prepareEffect: async () => { throw new Error("polling must not use bounded effects"); },
        completeEffect: async () => { throw new Error("polling must not checkpoint bounded effects"); },
        withRoom,
      }, async () => { calls++; assert.equal(getCurrentSupervisedRoomAuthority(), "room_exact"); return tool === "wait_for_messages" ? waitResult() : result("data"); }, tool, "codex", "supervised_mcp_polling");
      const fails = rejectAt === "before" || (rejectAt === "release" && tool !== "send_message");
      if (fails) await assert.rejects(handler({}, { requestId: 1 }), /stale authority/);
      else assert.deepEqual(await handler({}, { requestId: 1 }), tool === "wait_for_messages" ? waitResult() : result("data"));
      assert.equal(calls, rejectAt === "before" ? 0 : 1);
      assert.deepEqual(phases, rejectAt === "before" || tool === "send_message" ? ["before"] : ["before", "release"]);
    }
  }
});

test("custodial wait refuses missing durable cursor and cross-room inputs before callback", async () => {
  let calls = 0;
  const handler = registeredHandler({
    authorizePolling: async () => ({ roomId: "room_exact", roomCursor: null } as import("../server/runtime/supervisor-bridge.js").CustodialPollingAuthorization),
    prepareEffect: async () => { throw new Error("not reached"); }, completeEffect: async () => {}, withRoom,
  }, async () => { calls++; return result("not reached"); }, "wait_for_messages", "codex", "supervised_mcp_polling");
  await assert.rejects(handler({}, { requestId: 1 }), /no durable cursor/);
  await assert.rejects(handler({ room_id: "other" }, { requestId: 1 }), /exact authority/);
  assert.equal(calls, 0);
});

test("custodial waits preserve typed SDK identity, correct caller cursors and await exact bounded release", async () => {
  for (const [requestId, page, frontier] of [
    [1, {}, "msg_7"],
    [0, { last_observed_message_id: "msg_7", skipped_message_count: 0, skipped_message_ids: [] }, "msg_7"],
    ["1", { last_observed_message_id: "msg_19" }, "msg_19"],
    [2, { messages: [{ id: "msg_8" }], last_observed_message_id: "msg_8", truncated: true, omitted_message_count: 1 }, "msg_8"],
  ] as const) {
    const phases: string[] = [];
    const input = { after_message_id: "msg_900", timeout: 1000 };
    const authority = { roomId: "room_exact", roomCursor: "msg_7" } as import("../server/runtime/supervisor-bridge.js").CustodialPollingAuthorization;
    let release!: () => void;
    let reachedRelease!: () => void;
    const releaseGate = new Promise<void>(resolve => { release = resolve; });
    const reachedGate = new Promise<void>(resolve => { reachedRelease = resolve; });
    const handler = registeredHandler({
      authorizePolling: async (name, prior, wait) => {
        assert.equal(name, "wait_for_messages");
        phases.push(prior ? "release" : "before");
        assert.deepEqual(wait, { mcpRequestId: requestId, roomCursor: "msg_900", ...(prior ? { offeredFrontier: frontier } : {}) });
        if (prior) { assert.equal(prior, authority); reachedRelease(); await releaseGate; }
        return authority;
      }, prepareEffect: async () => { throw new Error("not reached"); }, completeEffect: async () => {}, withRoom,
    }, async received => {
      phases.push("callback");
      assert.deepEqual(received, { ...input, after_message_id: "msg_7" });
      return waitResult(page);
    }, "wait_for_messages", "codex", "supervised_mcp_polling");
    let returned = false;
    const pending = handler(input, { requestId }).then(value => { returned = true; return value; });
    await reachedGate;
    assert.equal(returned, false, "the provider cannot see messages before release is durable");
    assert.equal(input.after_message_id, "msg_900", "do not mutate the caller's request object");
    release();
    assert.deepEqual(await pending, waitResult(page));
    assert.deepEqual(phases, ["before", "callback", "release"]);
  }
});

test("custodial wait refuses missing SDK identity and never offers callback errors or malformed pages", async () => {
  for (const failure of ["missing_id", "unsafe_id", "callback", "error_result", "invalid_json", "missing_frontier", "silent_missing_frontier", "regressed_frontier", "equal_visible", "equal_skipped", "equal_truncated", "other_room"] as const) {
    const phases: string[] = [];
    const handler = registeredHandler({
      authorizePolling: async (_name, prior) => {
        phases.push(prior ? "release" : "before");
        return { roomId: "room_exact", roomCursor: "msg_7" } as import("../server/runtime/supervisor-bridge.js").CustodialPollingAuthorization;
      }, prepareEffect: async () => { throw new Error("not reached"); }, completeEffect: async () => {}, withRoom,
    }, async () => {
      phases.push("callback");
      if (failure === "callback") throw new Error("original callback error");
      if (failure === "error_result") return { ...waitResult(), isError: true };
      if (failure === "invalid_json") return result("invalid");
      if (failure === "missing_frontier") return waitResult({ messages: [{ id: "msg_8" }] });
      if (failure === "silent_missing_frontier") return waitResult({ skipped_message_count: 1 });
      if (failure === "regressed_frontier") return waitResult({ last_observed_message_id: "msg_6" });
      if (failure === "equal_visible") return waitResult({ messages: [{ id: "msg_7" }], last_observed_message_id: "msg_7" });
      if (failure === "equal_skipped") return waitResult({ skipped_message_count: 1, last_observed_message_id: "msg_7" });
      if (failure === "equal_truncated") return waitResult({ truncated: true, last_observed_message_id: "msg_7" });
      if (failure === "other_room") return waitResult({ room_id: "other" });
      return waitResult();
    }, "wait_for_messages", "codex", "supervised_mcp_polling");
    await assert.rejects(handler({ requestId: "not-an-SDK-id" }, failure === "missing_id" ? {} : { requestId: failure === "unsafe_id" ? Number.MAX_SAFE_INTEGER + 1 : 1 }),
      failure === "callback" ? /original callback error/ : /Custodial wait/);
    assert.deepEqual(phases, failure === "missing_id" || failure === "unsafe_id" ? [] : ["before", "callback"]);
  }
});

function registeredHandler(
  dependencies: SupervisedToolFacadeDependencies,
  callback: (input?: Record<string, unknown>) => Promise<CallToolResult>,
  toolName = "send_message",
  supervisedProvider: string | null = null,
  profile: "supervised_room_turn" | "supervised_mcp_polling" = "supervised_room_turn",
) {
  let handler: ((input: unknown, extra: { requestId?: string | number }) => Promise<CallToolResult>) | null = null;
  const server = {
    tool(_name: string, ...registration: unknown[]) {
      handler = registration.at(-1) as typeof handler;
      return {};
    },
  } as unknown as McpServer;
  const facade = profileAwareToolServer(server, profile, dependencies, supervisedProvider);
  (facade.tool as (...args: unknown[]) => unknown)(toolName, "description", {}, callback);
  assert.ok(handler);
  return handler;
}

test("supervised effects refuse a missing MCP request id before preparation", async () => {
  let prepared = false;
  const handler = registeredHandler({
    prepareEffect: async () => { prepared = true; throw new Error("not reached"); },
    completeEffect: async () => {},
    withRoom,
  }, async () => result("not reached"));
  await assert.rejects(() => handler({}, {}), /missing its MCP request id/);
  assert.equal(prepared, false);
});

test("new runtimes let a capable daemon execute and checkpoint the tool atomically", async () => {
  let prepared = false;
  let callbackCount = 0;
  const handler = registeredHandler({
    executeTool: async (input) => {
      assert.deepEqual(input, {
        toolName: "send_message",
        input: { text: "hello" },
        mcpRequestId: "request_daemon",
      });
      return { state: "completed", roomId: "room_exact", result: result("daemon result") };
    },
    prepareEffect: async () => { prepared = true; throw new Error("must not prepare locally"); },
    completeEffect: async () => {},
    withRoom,
  }, async () => { callbackCount += 1; return result("provider result"); });

  assert.deepEqual(await handler({ text: "hello" }, { requestId: "request_daemon" }), result("daemon result"));
  assert.equal(prepared, false);
  assert.equal(callbackCount, 0);
});

test("new runtimes fall back to provider execution when attached to an older daemon", async () => {
  let callbackCount = 0;
  const handler = registeredHandler({
    executeTool: async () => ({ state: "unsupported" }),
    prepareEffect: async () => ({ state: "prepared", roomId: "room_exact", effectId: "effect_old_daemon", action: "execute" }),
    completeEffect: async () => {},
    withRoom,
  }, async () => { callbackCount += 1; return result("provider result"); });

  assert.deepEqual(await handler({}, { requestId: "request_old_daemon" }), result("provider result"));
  assert.equal(callbackCount, 1);
});

test("completion transport failure never rewrites a successful callback as failed", async () => {
  let callbackCount = 0;
  const completions: Array<{ result?: unknown; error?: string }> = [];
  const handler = registeredHandler({
    prepareEffect: async () => ({ state: "prepared", roomId: "room_exact", effectId: "effect_exact", action: "execute" }),
    completeEffect: async (completion) => {
      completions.push(completion);
      throw new Error("completion socket unavailable");
    },
    withRoom,
  }, async () => { callbackCount += 1; return result("sent once"); });
  await assert.rejects(() => handler({}, { requestId: "request_exact" }), /completion socket unavailable/);
  assert.equal(callbackCount, 1);
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.error, undefined);
  assert.deepEqual(completions[0]?.result, result("sent once"));
});

test("large read results are returned live but checkpointed as a bounded replay instruction", async () => {
  const liveResult = result("x".repeat(80 * 1024));
  let checkpointedResult: unknown;
  const handler = registeredHandler({
    prepareEffect: async () => ({
      state: "prepared", roomId: "room_exact", effectId: "effect_large_read", action: "execute",
    }),
    completeEffect: async (completion) => { checkpointedResult = completion.result; },
    withRoom,
  }, async () => liveResult, "get_board");

  assert.equal(await handler({}, { requestId: "request_large_read" }), liveResult);
  const checkpoint = checkpointedResult as CallToolResult;
  assert.equal(checkpoint.structuredContent?.code, "SUPERVISED_READ_RESULT_NOT_RETAINED");
  assert.equal(typeof checkpoint.structuredContent?.serialized_bytes, "number");
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint), "utf8") < 4 * 1024);
});

test("large mutation results retain their exact durable completion evidence", async () => {
  const mutationResult = result("x".repeat(20 * 1024));
  let checkpointedResult: unknown;
  const handler = registeredHandler({
    prepareEffect: async () => ({
      state: "prepared", roomId: "room_exact", effectId: "effect_large_mutation", action: "execute",
    }),
    completeEffect: async (completion) => { checkpointedResult = completion.result; },
    withRoom,
  }, async () => mutationResult, "send_message");

  assert.equal(await handler({}, { requestId: "request_large_mutation" }), mutationResult);
  assert.equal(checkpointedResult, mutationResult);
});

test("failure-reporting errors do not mask the original callback error", async () => {
  const handler = registeredHandler({
    prepareEffect: async () => ({ state: "prepared", roomId: "room_exact", effectId: "effect_failed", action: "execute" }),
    completeEffect: async () => { throw new Error("journal unavailable"); },
    withRoom,
  }, async () => { throw new Error("tool failed first"); });
  await assert.rejects(() => handler({}, { requestId: "request_failed" }), /tool failed first/);
});

test("each callback sees the freshly prepared daemon room after a room move", async () => {
  const preparedRooms = ["source-room", "destination-room"];
  const callbackRooms: string[] = [];
  let preparationIndex = 0;
  const handler = registeredHandler({
    prepareEffect: async () => {
      const roomId = preparedRooms[preparationIndex];
      assert.ok(roomId);
      preparationIndex += 1;
      return {
        state: "prepared",
        roomId,
        effectId: `effect_${preparationIndex}`,
        action: "execute",
      };
    },
    completeEffect: async () => {},
    withRoom,
  }, async () => {
    const boundRoom = getCurrentSupervisedRoomAuthority();
    assert.ok(boundRoom, "the exact daemon room must be bound before the callback");
    callbackRooms.push(boundRoom);
    return result(boundRoom);
  });

  assert.deepEqual(await handler({}, { requestId: "request_source" }), result("source-room"));
  assert.deepEqual(await handler({}, { requestId: "request_destination" }), result("destination-room"));
  assert.deepEqual(callbackRooms, preparedRooms);
});

test("interleaved supervised tools retain independent exact room authority", async () => {
  let releaseSource!: () => void;
  let sourceStarted!: () => void;
  const sourceGate = new Promise<void>((resolve) => { releaseSource = resolve; });
  const sourceStartedGate = new Promise<void>((resolve) => { sourceStarted = resolve; });
  let callbackIndex = 0;
  const observed: string[] = [];
  const handler = registeredHandler({
    prepareEffect: async ({ mcpRequestId }) => ({
      state: "prepared",
      roomId: mcpRequestId === "request_source" ? "source-room" : "destination-room",
      effectId: `effect_${mcpRequestId}`,
      action: "execute",
    }),
    completeEffect: async () => {},
    withRoom,
  }, async () => {
    const index = callbackIndex++;
    observed.push(getCurrentSupervisedRoomAuthority() ?? "missing");
    if (index === 0) {
      sourceStarted();
      await sourceGate;
      observed.push(getCurrentSupervisedRoomAuthority() ?? "missing");
    }
    return result(getCurrentSupervisedRoomAuthority() ?? "missing");
  });

  const source = handler({}, { requestId: "request_source" });
  await sourceStartedGate;
  assert.deepEqual(await handler({}, { requestId: "request_destination" }), result("destination-room"));
  releaseSource();
  assert.deepEqual(await source, result("source-room"));
  assert.deepEqual(observed, ["source-room", "destination-room", "source-room"]);
});

test("every registered read-only tool is classified for safe supervised redrive", async () => {
  for (const toolName of [
    "get_current_room", "check_repo", "check_repo_visibility", "read_messages", "wait_for_messages",
    "get_board", "get_board_settings", "get_room_artifacts", "get_room_events", "list_board_intents",
    "get_onboarding_status", "status_local_codex_session", "rental_list_requests",
  ]) {
    let mutation: boolean | null = null;
    const handler = registeredHandler({
      prepareEffect: async (input) => {
        mutation = input.mutation;
        return { state: "prepared", roomId: "room_exact", effectId: `effect_${toolName}`, action: "execute" };
      },
      completeEffect: async () => {},
      withRoom,
    }, async () => result("read"), toolName);
    assert.deepEqual(await handler({}, { requestId: `request_${toolName}` }), result("read"));
    assert.equal(mutation, false, toolName);
  }
});

test("an uncertain mutation returns a durable safety instruction without invoking the tool again", async () => {
  let callbackCount = 0;
  let completionCount = 0;
  const handler = registeredHandler({
    prepareEffect: async () => ({
      state: "uncertain",
      roomId: "room_exact",
      effectId: "effect_uncertain",
      error: "The message may already have been sent.",
    }),
    completeEffect: async () => { completionCount += 1; },
    withRoom,
  }, async () => { callbackCount += 1; return result("must not run"); });

  const response = await handler({ text: "send once" }, { requestId: "request_uncertain" });
  assert.equal(callbackCount, 0);
  assert.equal(completionCount, 0);
  assert.deepEqual(response.structuredContent, {
    code: "SUPERVISED_EFFECT_OUTCOME_UNCERTAIN",
    effect_id: "effect_uncertain",
    detail: "The message may already have been sent.",
    instruction: "This mutating tool may already have completed, but its result was not durably checkpointed. Verify the external state before issuing a new request; this exact request will not be repeated automatically.",
  });
});

test("Cursor's blocked activating send retains the structured completion contract", async () => {
  let callbackCount = 0;
  const handler = registeredHandler({
    prepareEffect: async () => ({
      state: "prepared", roomId: "room_exact", effectId: "effect_cursor_reply", action: "use_final_answer", sourceMessageId: "msg_1",
    }),
    completeEffect: async () => {},
    withRoom,
  }, async () => { callbackCount += 1; return result("must not send"); }, "send_message", "cursor");

  const response = await handler({ text: "answer" }, { requestId: "request_cursor_reply" });
  assert.equal(callbackCount, 0);
  assert.match(String(response.structuredContent?.instruction), /complete_room_turn/);
  assert.doesNotMatch(String(response.structuredContent?.instruction), /Return it as your final answer/);
});

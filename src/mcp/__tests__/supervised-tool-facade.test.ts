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
      }, async () => { calls++; assert.equal(getCurrentSupervisedRoomAuthority(), "room_exact"); return result("data"); }, tool, "codex", "supervised_mcp_polling");
      const fails = rejectAt === "before" || (rejectAt === "release" && tool !== "send_message");
      if (fails) await assert.rejects(handler({}, {}), /stale authority/);
      else assert.deepEqual(await handler({}, {}), result("data"));
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
  await assert.rejects(handler({}, {}), /no durable cursor/);
  await assert.rejects(handler({ room_id: "other" }, {}), /exact authority/);
  assert.equal(calls, 0);
});

function registeredHandler(
  dependencies: SupervisedToolFacadeDependencies,
  callback: () => Promise<CallToolResult>,
  toolName = "send_message",
  supervisedProvider: string | null = null,
  profile: "supervised_room_turn" | "supervised_mcp_polling" = "supervised_room_turn",
) {
  let handler: ((input: unknown, extra: { requestId?: string }) => Promise<CallToolResult>) | null = null;
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

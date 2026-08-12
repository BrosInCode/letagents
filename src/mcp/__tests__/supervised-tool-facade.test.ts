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

function registeredHandler(
  dependencies: SupervisedToolFacadeDependencies,
  callback: () => Promise<CallToolResult>,
  toolName = "send_message",
  supervisedProvider: string | null = null,
) {
  let handler: ((input: unknown, extra: { requestId?: string }) => Promise<CallToolResult>) | null = null;
  const server = {
    tool(_name: string, ...registration: unknown[]) {
      handler = registration.at(-1) as typeof handler;
      return {};
    },
  } as unknown as McpServer;
  const facade = profileAwareToolServer(server, "supervised_room_turn", dependencies, supervisedProvider);
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

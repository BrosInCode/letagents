import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomMessageRoutes } = await import("../routes/room-messages.js");

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    messageEvents: new EventEmitter(),
    taskEvents: new EventEmitter(),
    resolveCanonicalRoomRequestId: unused,
    resolveRoomOrReply: unused,
    requireParticipant: unused,
    parseOptionalAgentPromptKind: () => null,
    parseOptionalReplyToMessageId: () => null,
    shouldIncludePromptOnlyMessages: () => false,
    emitProjectMessage: unused,
    rememberRoomParticipantFromMessage: unused,
  };
}

test("registerRoomMessageRoutes preserves canonical message route order", () => {
  const calls: Array<{ method: "get" | "post"; path: string }> = [];
  const app = {
    get(path: RegExp) {
      calls.push({ method: "get", path: path.toString() });
    },
    post(path: RegExp) {
      calls.push({ method: "post", path: path.toString() });
    },
  };

  registerRoomMessageRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "post", path: "/^\\/rooms\\/(.+)\\/messages$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/messages$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/messages\\/poll$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/messages\\/stream$/" },
  ]);
});

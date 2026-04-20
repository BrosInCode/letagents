import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerLegacyProjectMessageRoutes } = await import("../routes/legacy-project-messages.js");

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    messageEvents: new EventEmitter(),
    resolveCanonicalRoomRequestId: unused,
    requireParticipant: unused,
    parseOptionalAgentPromptKind: () => null,
    parseOptionalReplyToMessageId: () => null,
    shouldIncludePromptOnlyMessages: () => false,
    emitProjectMessage: unused,
    rememberRoomParticipantFromMessage: unused,
  };
}

test("registerLegacyProjectMessageRoutes preserves legacy message route order", () => {
  const calls: Array<{ method: "get" | "post"; path: string }> = [];
  const app = {
    get(path: string) {
      calls.push({ method: "get", path });
    },
    post(path: string) {
      calls.push({ method: "post", path });
    },
  };

  registerLegacyProjectMessageRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "post", path: "/projects/:id/messages" },
    { method: "get", path: "/projects/:id/messages" },
    { method: "get", path: "/projects/:id/messages/stream" },
    { method: "get", path: "/projects/:id/messages/poll" },
  ]);
});

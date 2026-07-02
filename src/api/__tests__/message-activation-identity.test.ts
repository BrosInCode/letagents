import assert from "node:assert/strict";
import test from "node:test";

import {
  LETAGENTS_AGENT_SESSION_ID_HEADER,
  LETAGENTS_AGENT_SESSION_TOKEN_HEADER,
} from "../../shared/request-headers.js";
import type { AuthenticatedRequest } from "../http/helpers.js";
import { resolveMessageActivationIdentity } from "../routes/rooms/messages/activation-identity.js";
import type { ResolvedRequestAgentIdentity } from "../request/agent-identity.js";

const workerIdentity: ResolvedRequestAgentIdentity = {
  actor_label: "CometLively | EmmyMay's agent | Agent",
  agent_key: "EmmyMay/cometlively",
  agent_instance_id: "agent_instance_1",
  agent_session_id: "agent_session_1",
  session_kind: "worker",
  runtime: "codex",
  display_name: "CometLively",
  owner_label: "EmmyMay",
  ide_label: "Agent",
  repo_branch: "codex/activation-routing-advisory",
};

function requestWithHeaders(headers: Record<string, string>): AuthenticatedRequest {
  return {
    get(name: string) {
      return headers[name];
    },
  } as AuthenticatedRequest;
}

test("resolveMessageActivationIdentity resolves worker session headers", async () => {
  const req = requestWithHeaders({
    [LETAGENTS_AGENT_SESSION_ID_HEADER]: "agent_session_1",
    [LETAGENTS_AGENT_SESSION_TOKEN_HEADER]: "token_1",
  });
  const calls: unknown[] = [];

  const identity = await resolveMessageActivationIdentity(req, "room_1", {
    resolveRequestAgentIdentity: async (input) => {
      calls.push(input);
      return workerIdentity;
    },
  });

  assert.equal(identity, workerIdentity);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    req,
    room_id: "room_1",
    agent_session_id: "agent_session_1",
    agent_session_token: "token_1",
  });
});

test("resolveMessageActivationIdentity hides controller identities", async () => {
  const req = requestWithHeaders({
    [LETAGENTS_AGENT_SESSION_ID_HEADER]: "agent_session_1",
    [LETAGENTS_AGENT_SESSION_TOKEN_HEADER]: "token_1",
  });

  const identity = await resolveMessageActivationIdentity(req, "room_1", {
    resolveRequestAgentIdentity: async () => ({
      ...workerIdentity,
      session_kind: "controller",
    }),
  });

  assert.equal(identity, null);
});

test("resolveMessageActivationIdentity ignores requests without session headers", async () => {
  const req = requestWithHeaders({});
  let called = false;

  const identity = await resolveMessageActivationIdentity(req, "room_1", {
    resolveRequestAgentIdentity: async () => {
      called = true;
      return workerIdentity;
    },
  });

  assert.equal(identity, null);
  assert.equal(called, false);
});

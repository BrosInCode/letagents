import assert from "node:assert/strict";
import test from "node:test";

import { RoomDeliveryControl, type ExactRoomDeliveryControlInput } from "../room-delivery-control.js";
import type { ProviderActionHandle } from "../provider-action-port.js";
import type { SupervisedAgentDelivery, SupervisedIngressAgent } from "../supervised-agent-delivery.js";
import type { DaemonManifestEntry } from "../types.js";
import type { WorkerSessionBinding } from "../worker-binding-store.js";

const input: ExactRoomDeliveryControlInput = {
  entryId: "agent-1",
  roomId: "room-1",
  sourceMessageId: "message-1",
  workAttemptId: "work-1",
  executionGenerationId: "execution-1",
  agentSessionId: "session-1",
  daemonGeneration: 7,
};

const entry = {
  id: input.entryId,
  room_id: input.roomId,
  provider: "codex",
  charter: "help",
  desired_state: "running",
  delivery_mode: "daemon_inbox",
  work_attempt_id: input.workAttemptId,
  provider_ref: {
    execution_generation_id: input.executionGenerationId,
    provider_continuation_id: "continuation-1",
    provider_connection: null,
  },
} as unknown as DaemonManifestEntry;

const binding = {
  entry_id: input.entryId,
  room_id: input.roomId,
  work_attempt_id: input.workAttemptId,
  execution_generation_id: input.executionGenerationId,
  agent_session_id: input.agentSessionId,
  api_url: "https://example.test",
} as WorkerSessionBinding;

const handle = {
  workAttemptId: input.workAttemptId,
  providerContinuationId: "continuation-1",
  providerConnection: null,
} as unknown as ProviderActionHandle;

function fixture(overrides: Partial<{
  entry: DaemonManifestEntry | null;
  binding: WorkerSessionBinding | null;
  handle: ProviderActionHandle | null;
  credential: string | null;
  exact: boolean;
  generation: number;
  runRoomTurn: boolean;
  repairContinuation: boolean;
}> = {}) {
  const calls: Array<{ method: string; agent: SupervisedIngressAgent; sourceMessageId: string }> = [];
  const delivery = {
    retry: async (agent: SupervisedIngressAgent, sourceMessageId: string) => { calls.push({ method: "retry", agent, sourceMessageId }); },
    restoreConversation: async (agent: SupervisedIngressAgent, sourceMessageId: string) => { calls.push({ method: "restore", agent, sourceMessageId }); },
    skipMessage: async (agent: SupervisedIngressAgent, sourceMessageId: string) => { calls.push({ method: "skip", agent, sourceMessageId }); },
  } as unknown as SupervisedAgentDelivery;
  const control = new RoomDeliveryControl({
    delivery,
    supportsRunRoomTurn: () => overrides.runRoomTurn ?? true,
    supportsRepairContinuation: () => overrides.repairContinuation ?? true,
    currentGeneration: () => overrides.generation ?? 7,
    getEntry: async () => overrides.entry === undefined ? entry : overrides.entry,
    getHandle: () => overrides.handle === undefined ? handle : overrides.handle,
    getBinding: async () => overrides.binding === undefined ? binding : overrides.binding,
    credentialFor: async () => overrides.credential === undefined ? "secret" : overrides.credential,
    isExactAuthority: async () => overrides.exact ?? true,
  });
  return { control, calls };
}

test("retry validates exact coordinates before capability checks", async () => {
  const { control } = fixture({ runRoomTurn: false });
  await assert.rejects(control.retry({ ...input, entryId: "" }), /Exact room delivery retry entryId is required/);
  await assert.rejects(control.retry(input), /does not support room delivery retry/);
});

test("retry rejects stale generations and exact binding mismatches", async () => {
  await assert.rejects(fixture({ generation: 8 }).control.retry(input), /generation changed; refresh before retrying/);
  await assert.rejects(fixture({ binding: { ...binding, room_id: "other" } }).control.retry(input), /binding is stale/);
});

test("retry reads credentials only after exact identity checks and invokes delivery", async () => {
  await assert.rejects(fixture({ credential: null }).control.retry(input), /credential handoff before retrying/);
  const { control, calls } = fixture();
  await control.retry(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "retry");
  assert.equal(calls[0]?.sourceMessageId, input.sourceMessageId);
  assert.equal(calls[0]?.agent.bearer, "secret");
  assert.equal(calls[0]?.agent.handle, handle);
});

test("retry rechecks runtime authority before invoking delivery", async () => {
  const { control, calls } = fixture({ exact: false });
  await assert.rejects(control.retry(input), /binding is no longer current/);
  assert.equal(calls.length, 0);
});

test("conversation restore requires a repair-capable provider and a live handle", async () => {
  await assert.rejects(fixture({ repairContinuation: false }).control.restoreConversation(input), /cannot restore provider conversations/);
  await assert.rejects(fixture({ handle: null }).control.restoreConversation(input), /delivery authority is stale/);
});

test("skip permits an exact credentialled agent without a live handle", async () => {
  const { control, calls } = fixture({ handle: null });
  await control.skip(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "skip");
  assert.equal(calls[0]?.agent.handle, null);
  assert.equal(calls[0]?.agent.providerContinuationId, "continuation-1");
});

test("restore and skip preserve control-coordinate and authority errors", async () => {
  await assert.rejects(fixture().control.skip({ ...input, sourceMessageId: "" }), /Exact room delivery control sourceMessageId is required/);
  await assert.rejects(fixture({ exact: false }).control.restoreConversation(input), /delivery authority changed/);
});

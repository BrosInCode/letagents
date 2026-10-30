// Shared fixtures for the supervised-agent-delivery-*.test.ts files that were split from supervised-agent-delivery.test.ts.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type ProviderActionHandle, type ProviderActionPort } from "../../provider-action-port.js";
import { ManifestStore } from "../../manifest-store.js";
import { SupervisedAgentDelivery } from "../../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../../supervised-agent-inbox-store.js";
import { RoomTurnAttachmentStager } from "../../room-turn-attachments.js";
import { projectDeliveryReceipts } from "../../manifest-view-projection.js";
import { DAEMON_PROTOCOL_VERSION } from "../../types.js";
import { connectDaemon } from "../../../../../shared/daemon-endpoint.mjs";

export const agent = {
  agentId: "stone", roomId: "room", provider: "codex", deliveryMode: "daemon_inbox" as const, apiUrl: "https://letagents.test", agentSessionId: "session-1", bearer: "memory", executionGenerationId: "generation-1", daemonGeneration: 1,
  handle: { workAttemptId: "attempt", providerContinuationId: "thread", pid: 1, providerConnection: { kind: "codex_app_server" as const, url: "ws://127.0.0.1:1", pid: 1, processIdentity: "test-process-birth" }, observedState: "working" as const },
  workAttemptId: "attempt", providerContinuationId: "thread", providerConnection: { kind: "codex_app_server" as const, url: "ws://127.0.0.1:1", pid: 1, processIdentity: "test-process-birth" },
};
export const currentAuthority = async () => true;
export const TEST_PROVIDER_TURN_AUTHORITY = {
  work_attempt_id: "attempt",
  origin_execution_generation_id: "generation-1",
  provider_continuation_id: "thread",
} as const;
export const provider = (
  runRoomTurn: NonNullable<ProviderActionPort["runRoomTurn"]>,
  recoverRoomTurn?: NonNullable<ProviderActionPort["recoverRoomTurn"]>,
  repairContinuation?: NonNullable<ProviderActionPort["repairContinuation"]>,
) => ({
  capabilities: async () => ({
    resume: true, midTurnInjection: false, transcriptAccess: true,
    permissionPromptBridging: false, survivesRestart: true,
    turnControl: "unsupported" as const,
    continuationRepair: repairContinuation ? "same_process" as const : "unsupported" as const,
  }),
  spawn: async () => { throw new Error("not used"); }, attach: async () => null, attachAction: async () => ({ state: "absent" as const }), resume: async () => { throw new Error("not used"); }, poke: async () => {}, stop: async () => ({ endedAt: "", exitCode: 0, signal: null, terminalCause: "stopped" as const, providerContinuationId: null }), onExit: async () => () => {}, runRoomTurn, recoverRoomTurn,
  repairContinuation,
} satisfies ProviderActionPort);

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for delivery progress.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function waitForAsync(check: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for asynchronous delivery progress.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function seedCursorRoomTurnCompletion(
  store: SupervisedAgentInboxStore,
  input: {
    agentId: string; roomId: string; executionGenerationId: string; workAttemptId: string;
    providerContinuationId: string; providerTurnId: string; outcome: "reply" | "no_reply"; text?: string;
  },
): Promise<void> {
  await store.prepareEffect({
    agent_id: input.agentId,
    room_id: input.roomId,
    execution_generation_id: input.executionGenerationId,
    provider_turn_id: input.providerTurnId,
    work_attempt_id: input.workAttemptId,
    current_execution_generation_id: input.executionGenerationId,
    provider_continuation_id: input.providerContinuationId,
    mcp_request_id: `test-complete:${input.providerTurnId}`,
    tool_name: "complete_room_turn",
    request: input.outcome === "reply"
      ? { outcome: "reply", text: input.text ?? "" }
      : { outcome: "no_reply" },
    mutation: true,
  });
}

export function installCursorCompletionProjectionFixture(store: SupervisedAgentInboxStore): (
  providerTurnId: string,
  completion: { outcome: "reply" | "no_reply"; text?: string },
) => void {
  const completions = new Map<string, { outcome: "reply" | "no_reply"; text?: string }>();
  const original = store.roomTurnCompletionEffects.bind(store);
  (store as unknown as {
    roomTurnCompletionEffects: (
      agentId: string, originExecutionGenerationId: string, providerTurnId: string,
    ) => Promise<Array<{ state: "completed"; request: { outcome: "reply" | "no_reply"; text?: string } }>>;
  }).roomTurnCompletionEffects = async (agentId, originExecutionGenerationId, providerTurnId) => {
    const completion = completions.get(providerTurnId);
    return completion
      ? [{ state: "completed", request: completion }]
      : original(agentId, originExecutionGenerationId, providerTurnId) as never;
  };
  return (providerTurnId, completion) => { completions.set(providerTurnId, completion); };
}

export async function daemonRequest(socketPath: string, method: string, params?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = connectDaemon(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newline)) as { ok: boolean; result?: unknown; error?: string });
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id: `delivery-${Date.now()}`, method, params })}\n`));
  });
}

export async function installExactTestProviderBirth(
  internals: {
    store: ManifestStore;
    manifestGeneration: number;
    providerStreams: {
      install(
        entryId: string,
        handle: ProviderActionHandle,
        executionGenerationId: string,
        mayStartDelivery: () => boolean,
      ): Promise<void>;
    };
  },
  entryId: string,
  handle: ProviderActionHandle,
  executionGenerationId: string,
): Promise<void> {
  const entry = await internals.store.getEntry(entryId);
  assert.ok(entry?.work_attempt_id && entry.workspace_path && handle.providerConnection);
  const database = (internals.store as unknown as { database: DatabaseSync }).database;
  database.prepare(`INSERT OR IGNORE INTO work_attempts(
    work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,
    workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    entry.work_attempt_id,
    `task:${entryId}`,
    `lease:${entryId}`,
    1,
    entry.workspace_path,
    "repo",
    "remote",
    "revision",
    `${entry.workspace_path}/.bare`,
    "active",
    new Date().toISOString(),
  );
  database.prepare(`INSERT OR IGNORE INTO work_attempt_executions(
    execution_generation_id,work_attempt_id,started_at,actor,generation,terminal_json
  ) VALUES(?,?,?,?,?,NULL)`).run(
    executionGenerationId,
    entry.work_attempt_id,
    new Date().toISOString(),
    "test",
    1,
  );
  const snapshot = await internals.store.load();
  const birth = await internals.store.checkpointProviderBirth(snapshot.generation, {
    entry,
    executionGenerationId,
    providerConnection: handle.providerConnection,
    appliedRevision: handle.appliedConfigurationRevision ?? 1,
    requestedAuthorityMode: "typed_shadow",
    observedAtMs: Date.now(),
  });
  internals.manifestGeneration = birth.generation;
  await internals.providerStreams.install(entryId, handle, executionGenerationId, () => false);
}

export async function enqueue(store: SupervisedAgentInboxStore, id = "1") {
  await ingest(store, id);
  return (await store.claimHead(agent.agentId))!;
}

export async function ingest(store: SupervisedAgentInboxStore, id = "1", activation: Record<string, unknown> = {}) {
  await store.ingestPoll({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: id, messages: [{ source_message_id: id, source_message: { id }, activation }] });
}

export const continuityTask = { id: "task_1", title: "Existing work", leaseId: "lease-1", epoch: 2 };

/**
 * A lease holder whose provider turns end with `failures` in order, then succeed with no reply.
 * A turn listed in `refusedTurns` (counted from one) is one the provider marked as a refusal.
 */
export async function runNoReplyContinuity(failures: readonly string[], rounds: readonly (readonly string[])[], refusedTurns: readonly number[] = [],
  /** What the room's messages carry as activation: everything in it comes from the server. */
  activation: Record<string, unknown> = {},
  /** Turns (counted from one) that the provider's adapter marked as ended on a result of a shape it does not know. */
  unrecognizedTurns: readonly number[] = []) {
  const root = await mkdtemp(join(tmpdir(), "continuity-no-reply-"));
  let tick = 0;
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"),
    () => new Date(Date.parse("2026-10-01T00:00:00.000Z") + (tick++) * 1_000).toISOString());
  const sources: string[] = []; const prompts: string[] = [];
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    const source = request.sourceMessage as { id?: string; source?: string; text?: string };
    sources.push(source.source === "system" ? "continuation" : String(source.id));
    if (source.source === "system") prompts.push(String(source.text));
    const turnId = `turn-${sources.length}`;
    await options?.checkpointTurnStarted?.(turnId);
    const error = failures[sources.length - 1];
    return error
      ? { turnId, providerContinuationId: "thread", outcome: "failed", text: null, evidence: "transcript", error,
        ...(refusedTurns.includes(sources.length) ? { refusal: true as const } : {}),
        ...(unrecognizedTurns.includes(sources.length) ? { unrecognizedResult: true as const } : {}) }
      : { turnId, outcome: "no_reply", text: null };
  }), { poll: async () => ({}), publish: async () => {}, ownedTasks: async () => [continuityTask] },
  currentAuthority, 0, async () => {});
  try {
    for (const ids of rounds) {
      for (const id of ids) await ingest(store, id, activation);
      await delivery.pump(agent);
    }
    return { receipts: await store.receipts(agent.agentId), sources, prompts };
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
}

export type ClaudeFacts = { status: number | null; terminalReason: string | null; category: string | null; usageLimit?: true; promptTooLong?: true };
export const RETRY_DELIVERY = "Resolve this issue, then use Retry delivery to continue the existing task.";
/** How long each of the three follow-ups waits after a short provider fault: 30 seconds, 2 minutes, 10 minutes. */
export const SHORT_FAULT_WAITS = [30_000, 120_000, 600_000] as const;
/** The decision for a short fault at this follow-up attempt. */
export const temporaryAt = (attempt: number) => ({ automatic: true, detail: "The provider failed temporarily. The agent will try again by itself.", kind: "provider_fault",
  delayMs: SHORT_FAULT_WAITS[attempt - 1]! });
/** Added to Claude's own text on the follow-up of a request that does not fit the model's context. */
export const DOES_NOT_FIT = "The request does not fit the model's context, so each turn in this conversation fails the same way. Start fresh opens a new conversation and discards the context of this one. After it, use Retry delivery, then send a message to continue the task. If the size comes from attachments or tools, a new conversation may not help.";
export const STOPPED_AFTER_THREE = "All three automatic attempts failed. The agent now waits for you: check the provider, then use Retry delivery to try again. Existing work is preserved.";
/** What the manifest says of a follow-up that waits for its time after a short provider fault. */
export const scheduledFault = (at_ms: number, attempt: number, for_message_id: string | null = "1") =>
  ({ for_message_id, state: "scheduled", scheduled: { at_ms, attempt, attempts: 3, kind: "provider_fault" } });
export const STOPPED_BY_OWNER = "You stopped the automatic attempts. The task is still assigned to this agent. Send it a message to continue.";
/** What Skip says on a follow-up that was blocked: what the owner did, and what is left as it is. It says nothing of attempts that were stopped. */
export const SKIPPED_BY_OWNER = "You skipped the next attempt, and the task and its work lease are left as they are.";
/** What a follow-up says when it ended because an earlier action has an uncertain result. It names where the owner sees that action. */
export const FOLLOW_UP_ENDED_UNCERTAIN = "The agent did not try again: an earlier action has an uncertain result. Check what it did (the inspector shows its actions), then tell it to continue only the verified work.";

/**
 * A lease holder on the provider `providerId` whose turns fail as listed, in order, and then end with no reply. A
 * follow-up's delay is not waited for: the clock of the inbox is moved ahead by it, and `waits` keeps
 * what was asked for.
 */
export async function runFailingLeaseHolder(providerId: string, failures: ReadonlyArray<{ error: string; claudeApiFailure?: ClaudeFacts }>,
  rounds: readonly (readonly string[])[]) {
  const root = await mkdtemp(join(tmpdir(), "continuity-claude-facts-"));
  let nowMs = Date.parse("2026-10-01T00:00:00.000Z");
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"), () => new Date(nowMs).toISOString());
  const sources: string[] = []; const waits: number[] = [];
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    const source = request.sourceMessage as { id?: string; source?: string };
    sources.push(source.source === "system" ? "continuation" : String(source.id));
    const turnId = `turn-${sources.length}`;
    await options?.checkpointTurnStarted?.(turnId);
    const failure = failures[sources.length - 1];
    return failure
      ? { turnId, providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", ...failure }
      : { turnId, outcome: "no_reply", text: null };
  }), { poll: async () => ({}), publish: async () => {}, ownedTasks: async () => [continuityTask] },
  currentAuthority, 50, async () => {}, async (delayMs) => { waits.push(delayMs); nowMs += delayMs; });
  try {
    for (const ids of rounds) {
      for (const id of ids) await ingest(store, id);
      await delivery.pump({ ...agent, provider: providerId });
    }
    return { receipts: await store.receipts(agent.agentId), sources, waits };
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
}

/**
 * A lease holder whose every turn ends on a short provider fault, on a daemon whose waits end only when something
 * ends them: the daemon stops, or the owner uses Try now or Stop trying. The clock of the inbox is the test's.
 */
export async function scheduledRetryFixture(providerId = "claude-code") {
  const root = await mkdtemp(join(tmpdir(), "continuity-scheduled-retry-"));
  const path = join(root, "state.sqlite");
  const clock = { nowMs: Date.parse("2026-10-01T00:00:00.000Z") };
  const fault: { error: string; claudeApiFailure?: ClaudeFacts } =
    { error: "API Error: Repeated 529 Overloaded errors.", claudeApiFailure: { status: 529, terminalReason: "api_error", category: "server_error" } };
  const sources: string[] = []; const waits: number[] = [];
  let failing = true;
  /**
   * `turnStarts`: the next turn is held here, after it was claimed and before its turn id is saved.
   * `ownedTasks`: runs once, the next time the daemon asks which tasks the agent holds. `held`: what it then holds.
   */
  const hooks: { turnStarts: Promise<void> | null; ownedTasks: (() => Promise<void>) | null; held: typeof continuityTask[] } =
    { turnStarts: null, ownedTasks: null, held: [continuityTask] };
  const port = provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    const source = request.sourceMessage as { id?: string; source?: string };
    sources.push(source.source === "system" ? "continuation" : String(source.id));
    const turnId = `turn-${sources.length}`;
    await hooks.turnStarts;
    await options?.checkpointTurnStarted?.(turnId);
    return failing ? { turnId, providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", ...fault }
      : { turnId, outcome: "no_reply", text: null };
  });
  const claude = { ...agent, provider: providerId };
  let store = new SupervisedAgentInboxStore(path, () => new Date(clock.nowMs).toISOString());
  const makeDelivery = () => new SupervisedAgentDelivery(store, port, { poll: async () => ({}), publish: async () => {},
    ownedTasks: async () => { const hook = hooks.ownedTasks; hooks.ownedTasks = null; await hook?.(); return hooks.held; } },
    currentAuthority, 50, async () => {}, (delayMs, signal) => new Promise<void>((resolve) => {
      waits.push(delayMs);
      if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
    }));
  let delivery = makeDelivery();
  const view = async () => projectDeliveryReceipts(await store.receiptProjection(agent.agentId), null)!;
  return { clock, fault, sources, waits, claude, view, hooks, path,
    store: () => store, delivery: () => delivery,
    /** The provider recovers: the next turn ends with no reply instead of the fault. */
    providerRecovers: () => { failing = false; },
    /** The follow-up that waits for its time, as the manifest shows it. */
    scheduled: async () => (await view()).find((receipt) => receipt.follow_up?.scheduled) ?? null,
    /** Send room message `id` and let the daemon work until it waits `waiting` times in all, or is idle. */
    say: async (id: string, waiting: number) => {
      await ingest(store, id);
      void delivery.pump(claude).catch(() => undefined);
      await waitForAsync(async () => waits.length >= waiting);
    },
    /**
     * The daemon ends and a new one takes the same saved state over. The clock goes on by `downMs` in between. The
     * new one works for `as`, and `beforePump` runs on it before it starts to work. `pump` settles when that work ends:
     * while a follow-up waits for its time, that is when something ends the wait.
     */
    restartDaemon: async (downMs: number, as: typeof claude = claude, beforePump?: () => void) => {
      await delivery.fenceAndDrain();
      await store.close();
      clock.nowMs += downMs;
      store = new SupervisedAgentInboxStore(path, () => new Date(clock.nowMs).toISOString());
      delivery = makeDelivery();
      beforePump?.();
      return { pump: delivery.pump(as).catch(() => undefined) };
    },
    cleanup: async () => { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

export async function recordThreadIntent(path: string, store: SupervisedAgentInboxStore, turnId: string): Promise<void> {
  const manifest = new ManifestStore(path);
  try {
    const loaded = await manifest.load();
    await manifest.write(loaded.generation, [{
      id: agent.agentId, room_id: agent.roomId, display_name: "Stone", provider: "codex", model: null,
      charter: "test", desired_state: "running", observed_state: "working", condition: "none",
      permission_profile_id: null, delivery_mode: "daemon_inbox", provider_launch_policy: {}, created_by: "test",
      created_at: new Date().toISOString(), work_attempt_id: agent.workAttemptId,
      provider_ref: { work_attempt_id: agent.workAttemptId, execution_generation_id: agent.executionGenerationId,
        provider_continuation_id: agent.providerContinuationId, provider_connection: agent.providerConnection },
    }]);
  } finally { await manifest.close(); }
  const intent = await store.prepareEffect({ agent_id: agent.agentId, room_id: agent.roomId,
    execution_generation_id: agent.executionGenerationId, current_execution_generation_id: agent.executionGenerationId,
    provider_turn_id: turnId, provider_continuation_id: agent.providerContinuationId, work_attempt_id: agent.workAttemptId,
    mcp_request_id: "thread-choice", tool_name: "set_reply_thread", request: {}, mutation: true });
  assert.equal(intent.effect.state, "completed");
}

export async function recordReplyIntent(path: string, store: SupervisedAgentInboxStore, turnId: string, toolName: string, request: unknown): Promise<void> {
  const manifest = new ManifestStore(path);
  try {
    const loaded = await manifest.load();
    await manifest.write(loaded.generation, [{
      id: agent.agentId, room_id: agent.roomId, display_name: "Stone", provider: "codex", model: null,
      charter: "test", desired_state: "running", observed_state: "working", condition: "none",
      permission_profile_id: null, delivery_mode: "daemon_inbox", provider_launch_policy: {}, created_by: "test",
      created_at: new Date().toISOString(), work_attempt_id: agent.workAttemptId,
      provider_ref: { work_attempt_id: agent.workAttemptId, execution_generation_id: agent.executionGenerationId,
        provider_continuation_id: agent.providerContinuationId, provider_connection: agent.providerConnection },
    }]);
  } finally { await manifest.close(); }
  const intent = await store.prepareEffect({ agent_id: agent.agentId, room_id: agent.roomId,
    execution_generation_id: agent.executionGenerationId, current_execution_generation_id: agent.executionGenerationId,
    provider_turn_id: turnId, provider_continuation_id: agent.providerContinuationId, work_attempt_id: agent.workAttemptId,
    mcp_request_id: `${toolName}-choice`, tool_name: toolName, request, mutation: true });
  assert.equal(intent.effect.state, "completed");
}

export async function writeAgentRuntime(path: string, providerContinuationId: string): Promise<void> {
  const manifest = new ManifestStore(path);
  try {
    const loaded = await manifest.load();
    await manifest.write(loaded.generation, [{
      id: agent.agentId, room_id: agent.roomId, display_name: "Stone", provider: "codex", model: null,
      charter: "test", desired_state: "running", observed_state: "working", condition: "none",
      permission_profile_id: null, delivery_mode: "daemon_inbox", provider_launch_policy: {}, created_by: "test",
      created_at: new Date().toISOString(), work_attempt_id: agent.workAttemptId,
      provider_ref: { work_attempt_id: agent.workAttemptId, execution_generation_id: agent.executionGenerationId,
        provider_continuation_id: providerContinuationId, provider_connection: agent.providerConnection },
    }]);
  } finally { await manifest.close(); }
}

/** The saved turn's own execution, `generation-1` of work attempt `attempt`, with or without a recorded terminal. */
export function recordExecution(database: { exec(sql: string): void; prepare(sql: string): { run(...values: Array<string | null>): unknown } }, ended: boolean): void {
  database.exec(`INSERT INTO work_attempts(work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at)
    VALUES('attempt','task','lease',1,'/private/workspace','repo','remote','revision','/private/bare','active','2026-08-31T00:00:00.000Z')`);
  database.prepare("INSERT INTO work_attempt_executions VALUES('generation-1','attempt','2026-08-31T00:00:00.000Z','test',1,?)")
    .run(ended ? JSON.stringify({ ended_at: "2026-08-31T00:01:00.000Z", terminal_cause: "crashed" }) : null);
}

export const STAGED_PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
export const imageMessage = (id: string, attachments: unknown[]) => ({ id, text: "What is wrong on this screen?", attachments,
  activation: { for_current_agent: { decision: "activate", reason: "mention" } } });
export const pngAttachment = (id: string) => ({ id, filename: "screen.png", content_type: "image/png", byte_size: STAGED_PNG.byteLength,
  download_url: `/rooms/room/messages/msg_5/attachments/${id}` });
export const withAttachmentStager = (store: SupervisedAgentInboxStore, port: ProviderActionPort, http: ConstructorParameters<typeof SupervisedAgentDelivery>[2], stager: RoomTurnAttachmentStager) =>
  new SupervisedAgentDelivery(store, port, http, currentAuthority, 0, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, stager);

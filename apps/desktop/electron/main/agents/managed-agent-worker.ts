import type {
  DesktopManagedAgentFailure,
  DesktopManagedAgentSession,
  DesktopRoomStorageState,
  DesktopRoomStreamEvent,
} from "../../ipc-types.js";
import { desktopEventPublicReplyText } from "./codex-event-prompt.js";
import {
  createDesktopDeliverySignalGuard,
  createDesktopDeliverySignalLane,
  type DesktopDeliverySignalGeneration,
  type DesktopDeliverySignalLane,
} from "./managed-agent-delivery-signal.js";
import {
  desktopManagedAgentReplyTargetForMessage,
  persistDesktopManagedAgentLocalReply,
  persistDesktopManagedAgentLocalReplyWithDeferredWriteNotification,
  type DesktopManagedAgentReplyTarget,
} from "./managed-agent-local-replies.js";
import {
  createLocalDesktopManagedAgentWorkerSession,
  resolveDesktopManagedAgentWorkerRegistration,
  shouldUseCloudDesktopManagedAgentWorkerSession,
} from "./managed-agent-local-worker-session.js";
import {
  buildDesktopManagedAgentReplyChangeContext,
  localDesktopManagedAgentReplyChangeAttachments,
  prepareDesktopManagedAgentReplyChangeSummaryArtifactWrite,
  publishDesktopManagedAgentReplyChangeSummaryArtifact,
  rememberDesktopManagedAgentReplyChangeAttachment,
  stageDesktopManagedAgentReplyChangeAttachment,
} from "./managed-agent-reply-changes.js";
import {
  getOrCreateDesktopHostId,
  getStoredAgentIdentity,
  getStoredAgentIdentityForRuntimeKey,
  getStoredAgentSession,
  markAgentSessionEnded,
  saveAgentSession,
  saveStoredAgentIdentity,
  supervisorEntryIdForAgentSession,
  type StoredAgentIdentityState,
  type StoredAgentSessionState,
  type DesktopManagedLiveSessionBase,
} from "./state.js";

type ManagedRoomEvent = Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>;
const DESKTOP_DELIVERY_HEARTBEAT_MS = 30_000;
const desktopDeliveryHeartbeatTimers = new Map<string, NodeJS.Timeout>();
interface DesktopDeliverySignalRuntime {
  lane: DesktopDeliverySignalLane;
  epoch: number;
  desiredState: string | null;
  generation: DesktopDeliverySignalGeneration;
  nextServerSequence: number;
}
const desktopDeliverySignalRuntimes = new Map<string, DesktopDeliverySignalRuntime>();
// Stops a worker whose delivery lease the server no longer recognises from
// storming desktop-heartbeat/desktop-pause: 404/410 is terminal, everything
// else backs off (the PR #715 pause-spam caveat).
const desktopDeliverySignalGuard = createDesktopDeliverySignalGuard();

function desktopDeliverySignalRuntime(sessionId: string): DesktopDeliverySignalRuntime {
  let runtime = desktopDeliverySignalRuntimes.get(sessionId);
  if (!runtime) {
    const lane = createDesktopDeliverySignalLane();
    runtime = {
      lane,
      epoch: 0,
      desiredState: null,
      generation: lane.advance(),
      nextServerSequence: 0,
    };
    desktopDeliverySignalRuntimes.set(sessionId, runtime);
  }
  return runtime;
}

function selectDesktopDeliverySignalState(
  sessionId: string,
  desiredState: string,
): DesktopDeliverySignalRuntime {
  const runtime = desktopDeliverySignalRuntime(sessionId);
  if (runtime.desiredState !== desiredState) {
    runtime.epoch += 1;
    runtime.desiredState = desiredState;
    runtime.generation = runtime.lane.advance();
  }
  return runtime;
}

function restartDesktopDeliverySignalState(sessionId: string): void {
  const runtime = desktopDeliverySignalRuntime(sessionId);
  runtime.epoch += 1;
  runtime.desiredState = null;
  runtime.generation = runtime.lane.advance();
}

function nextDesktopDeliverySignalSequence(runtime: DesktopDeliverySignalRuntime): number {
  runtime.nextServerSequence += 1;
  return runtime.nextServerSequence;
}

function reconcileDesktopDeliverySignalSequence(
  runtime: DesktopDeliverySignalRuntime,
  error: unknown,
): boolean {
  const candidate = error && typeof error === "object"
    ? error as {
        status?: unknown;
        payload?: { code?: unknown; current_delivery_signal_sequence?: unknown } | null;
      }
    : null;
  if (candidate?.status !== 409 || candidate.payload?.code !== "stale_delivery_signal") return false;
  const current = candidate.payload.current_delivery_signal_sequence;
  if (typeof current === "number" && Number.isSafeInteger(current) && current >= 0) {
    runtime.nextServerSequence = Math.max(runtime.nextServerSequence, current);
  }
  return true;
}

function retireDesktopDeliverySignalRuntime(
  sessionId: string,
  runtime: DesktopDeliverySignalRuntime,
): void {
  if (desktopDeliverySignalRuntimes.get(sessionId) === runtime) {
    desktopDeliverySignalRuntimes.delete(sessionId);
  }
}

function retireDesktopDeliverySignalRuntimeAfterDrain(
  sessionId: string,
  runtime: DesktopDeliverySignalRuntime,
): void {
  const generation = runtime.generation;
  void runtime.lane.run(generation, `retire:${runtime.epoch}`, async () => undefined)
    .finally(() => {
      if (
        runtime.lane.isCurrent(generation)
        && !desktopDeliveryHeartbeatTimers.has(sessionId)
      ) retireDesktopDeliverySignalRuntime(sessionId, runtime);
    });
}

// Terminal teardown for a delivery signal: stop the heartbeat and end the
// session locally, but keep the guard's terminal flag so any repeated
// in-flight pause calls short-circuit instead of re-POSTing.
function tearDownDesktopDeliverySignal(sessionId: string): void {
  stopDesktopManagedWorkerDeliveryHeartbeat(sessionId);
  const runtime = desktopDeliverySignalRuntime(sessionId);
  restartDesktopDeliverySignalState(sessionId);
  markAgentSessionEnded(sessionId);
  retireDesktopDeliverySignalRuntimeAfterDrain(sessionId, runtime);
}

// The shared worker plumbing deliberately lazy-imports auth.js,
// room-stream.js, and rooms/local-store.js inside its functions: room-stream
// statically imports codex-supervisor (and window.js -> electron), so a
// static edge here would pull every runtime into that cycle.

export type AgentIdentityCreateResponse = {
  name?: string;
  display_name?: string;
  owner_label?: string;
  canonical_key?: string;
};

export type AgentSessionCreateResponse = {
  session_id?: string;
  session_token?: string;
  room_id?: string;
  session_kind?: string;
  runtime?: string;
  host_id?: string | null;
  host_kind?: string | null;
  host_label?: string | null;
  liveness_capability?: string | null;
  tool_bridge_id?: string | null;
  actor_label?: string | null;
  agent_key?: string | null;
  agent_instance_id?: string | null;
  display_name?: string | null;
  owner_label?: string | null;
  ide_label?: string | null;
  repo_branch?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_seen_at?: string | null;
  ended_at?: string | null;
};

export type ManagedAgentWorkerProvider = {
  /** Stored/registered IDE label, e.g. "Codex", "Claude Code", "Cursor". */
  ideLabel: string;
  /** Runtime marker prefix, e.g. "codex" -> runtime "codex:<token>". */
  runtimePrefix: string;
  /** Agent instance prefix, e.g. "desktop-codex" -> "desktop-codex:<token>". */
  instancePrefix: string;
  livenessCapability: string;
  identityNameFallback: string;
  signInErrorMessage: string;
  unusableIdentityErrorMessage: string;
  missingActorKeyErrorMessage: string;
  /**
   * Codex predates per-runtime identities and may fall back to the stored
   * global identity when its display name matches the requested one.
   */
  allowLegacyGlobalIdentity?: boolean;
  /** Label used in reply-attachment console warnings. */
  replyWarnLabel: string;
};

export function managedAgentWorkerRuntime(provider: ManagedAgentWorkerProvider, token: string): string {
  return `${provider.runtimePrefix}:${token}`;
}

export function managedAgentWorkerInstanceId(provider: ManagedAgentWorkerProvider, token: string): string {
  return `${provider.instancePrefix}:${token}`;
}

export function managedAgentWorkerLivenessRegistration(
  provider: ManagedAgentWorkerProvider,
  runtime: string,
  token: string,
): Record<string, string | null> {
  const hostId = getOrCreateDesktopHostId();
  return {
    host_id: hostId,
    host_kind: process.platform === "darwin" ? "macos" : process.platform,
    host_label: "LetAgents Desktop",
    liveness_capability: provider.livenessCapability,
    tool_bridge_id: `${hostId}:${runtime}:desktop:${token}`,
  };
}

export async function ensureDesktopManagedWorkerIdentity(
  provider: ManagedAgentWorkerProvider,
  displayName: string,
): Promise<StoredAgentIdentityState> {
  const requestedName = normalizeAgentIdentityName(displayName, provider.identityNameFallback);
  const requestedDisplayName = normalizeDisplayText(displayName, provider.ideLabel);
  const runtimeKey = `${provider.instancePrefix}:${requestedName}`;
  const existingForName = getStoredAgentIdentityForRuntimeKey(runtimeKey);
  if (isUsableAgentIdentity(existingForName)) {
    return existingForName;
  }

  if (provider.allowLegacyGlobalIdentity) {
    const existing = getStoredAgentIdentity();
    if (
      isUsableAgentIdentity(existing) &&
      normalizeAgentIdentityName(existing.display_name, provider.identityNameFallback) === requestedName
    ) {
      return existing;
    }
  }

  const { apiFetch, readStoredAuth } = await import("../auth.js");
  const storedAuth = await readStoredAuth();
  if (!storedAuth.token) {
    throw new Error(provider.signInErrorMessage);
  }

  const ownerLabel = normalizeDisplayText(
    storedAuth.account?.displayName || storedAuth.account?.login,
    "Desktop",
  );
  const registered = await apiFetch<AgentIdentityCreateResponse>("/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: requestedName,
      display_name: requestedDisplayName,
      owner_label: ownerLabel,
    }),
  });
  const canonicalKey = normalizeDisplayText(registered.canonical_key, "");
  if (!canonicalKey) {
    throw new Error(provider.unusableIdentityErrorMessage);
  }

  const resolvedDisplayName = normalizeDisplayText(registered.display_name, requestedDisplayName);
  const resolvedOwnerLabel = normalizeDisplayText(registered.owner_label, ownerLabel);
  const now = new Date().toISOString();
  return saveStoredAgentIdentity({
    name: normalizeDisplayText(registered.name, requestedName),
    display_name: resolvedDisplayName,
    owner_label: resolvedOwnerLabel,
    owner_attribution: formatOwnerAttribution(resolvedOwnerLabel),
    ide_label: provider.ideLabel,
    actor_label: buildAgentActorLabel({
      displayName: resolvedDisplayName,
      ownerLabel: resolvedOwnerLabel,
      ideLabel: provider.ideLabel,
    }),
    canonical_key: canonicalKey,
    runtime_key: runtimeKey,
    source: "api",
    resolved_at: now,
  });
}

export function toStoredManagedAgentSession(
  provider: ManagedAgentWorkerProvider,
  created: AgentSessionCreateResponse,
  input: {
    roomIdentifier: string;
    runtime: string;
    identity: StoredAgentIdentityState;
    agentInstanceId: string;
    displayName: string;
  },
): StoredAgentSessionState {
  const sessionId = normalizeDisplayText(created.session_id, "");
  const sessionToken = normalizeDisplayText(created.session_token, "");
  if (!sessionId || !sessionToken) {
    throw new Error("Agent session registration response was missing session credentials.");
  }

  const createdAt = normalizeDisplayText(created.created_at, new Date().toISOString());
  const updatedAt = normalizeDisplayText(created.updated_at, createdAt);
  return {
    session_id: sessionId,
    session_token: sessionToken,
    room_id: normalizeDisplayText(created.room_id, input.roomIdentifier),
    session_kind: created.session_kind === "controller" ? "controller" : "worker",
    runtime: normalizeDisplayText(created.runtime, input.runtime),
    host_id: created.host_id ?? null,
    host_kind: created.host_kind ?? null,
    host_label: created.host_label ?? null,
    liveness_capability: created.liveness_capability ?? null,
    tool_bridge_id: created.tool_bridge_id ?? null,
    actor_label: normalizeDisplayText(
      created.actor_label,
      buildAgentActorLabel({
        displayName: input.displayName,
        ownerLabel: input.identity.owner_label,
        ideLabel: provider.ideLabel,
      }),
    ),
    agent_key: normalizeDisplayText(created.agent_key, input.identity.canonical_key ?? ""),
    agent_instance_id: normalizeDisplayText(created.agent_instance_id, input.agentInstanceId),
    display_name: normalizeDisplayText(created.display_name, input.displayName),
    owner_label: normalizeDisplayText(created.owner_label, input.identity.owner_label),
    ide_label: normalizeDisplayText(created.ide_label, provider.ideLabel),
    repo_branch: normalizeDisplayText(created.repo_branch, "") || null,
    created_at: createdAt,
    updated_at: updatedAt,
    last_seen_at: normalizeDisplayText(created.last_seen_at, updatedAt),
    ended_at: created.ended_at ?? null,
  };
}

export async function registerDesktopManagedWorker(
  provider: ManagedAgentWorkerProvider,
  input: {
    roomIdentifier: string;
    displayName: string;
    token: string;
    repoBranch: string | null;
    /** Optional per-session IDE label override supplied by the managed provider. */
    ideLabel?: string;
  },
): Promise<StoredAgentSessionState> {
  const runtime = managedAgentWorkerRuntime(provider, input.token);
  const agentInstanceId = managedAgentWorkerInstanceId(provider, input.token);
  const registrationLiveness = managedAgentWorkerLivenessRegistration(provider, runtime, input.token);
  const registration = await resolveDesktopManagedAgentWorkerRegistration({
    roomIdentifier: input.roomIdentifier,
  });
  const localSession = registration.storage.effectiveMode === "local"
    ? await createLocalDesktopManagedAgentWorkerSession({
      roomIdentifier: input.roomIdentifier,
      runtime,
      agentInstanceId,
      displayName: input.displayName,
      ideLabel: input.ideLabel || provider.ideLabel,
      repoBranch: input.repoBranch,
      registrationLiveness,
    }, registration.storage)
    : null;
  if (localSession) {
    return localSession;
  }

  const identity = await ensureDesktopManagedWorkerIdentity(provider, input.displayName);
  const actorKey = normalizeDisplayText(identity.canonical_key, "");
  if (!actorKey) {
    throw new Error(provider.missingActorKeyErrorMessage);
  }

  const { apiFetch } = await import("../auth.js");
  const cloudRoomIdentifier = registration.cloudRoomIdentifier;
  const created = await apiFetch<AgentSessionCreateResponse>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/agent-sessions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actor_key: actorKey,
        actor_label: identity.actor_label,
        ide_label: input.ideLabel || provider.ideLabel,
        agent_instance_id: agentInstanceId,
        display_name: input.displayName,
        session_kind: "worker",
        runtime,
        repo_branch: input.repoBranch,
        registration_liveness: registrationLiveness,
      }),
    },
  );

  const session = saveAgentSession(toStoredManagedAgentSession(provider, created, {
    roomIdentifier: cloudRoomIdentifier,
    runtime,
    identity,
    agentInstanceId,
    displayName: input.displayName,
  }));
  startDesktopManagedWorkerDeliveryHeartbeat(session, input.roomIdentifier);
  return session;
}

export function stopDesktopManagedWorkerDeliveryHeartbeat(sessionId: string): void {
  const timer = desktopDeliveryHeartbeatTimers.get(sessionId);
  if (timer) clearInterval(timer);
  desktopDeliveryHeartbeatTimers.delete(sessionId);
}

export function endDesktopManagedWorkerSession(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  stopDesktopManagedWorkerDeliveryHeartbeat(sessionId);
  const runtime = desktopDeliverySignalRuntime(sessionId);
  restartDesktopDeliverySignalState(sessionId);
  desktopDeliverySignalGuard.forget(sessionId);
  markAgentSessionEnded(sessionId);
  retireDesktopDeliverySignalRuntimeAfterDrain(sessionId, runtime);
}

async function postDesktopManagedWorkerDeliveryHeartbeat(
  session: StoredAgentSessionState,
  streamRoomIdentifier: string,
): Promise<void> {
  const runtimeAtInvocation = desktopDeliverySignalRuntime(session.session_id);
  const invocationEpoch = runtimeAtInvocation.epoch;
  const invocationIsCurrent = (): boolean => (
    desktopDeliverySignalRuntimes.get(session.session_id) === runtimeAtInvocation
    && runtimeAtInvocation.epoch === invocationEpoch
  );
  if (!(await shouldUseCloudDesktopManagedAgentWorkerSession(session))) return;
  if (!invocationIsCurrent()) return;

  const { getActiveRoomIdentifier } = await import("../room-stream.js");
  if (!invocationIsCurrent()) return;
  const roomClosed = getActiveRoomIdentifier()?.trim() !== streamRoomIdentifier.trim();
  const desiredState = roomClosed ? "room_closed" : "active";
  const runtime = selectDesktopDeliverySignalState(session.session_id, desiredState);
  await runtime.lane.run(runtime.generation, desiredState, async (isCurrent) => {
    const decision = roomClosed
      ? desktopDeliverySignalGuard.beforeStateChange(session.session_id, "room_closed")
      : desktopDeliverySignalGuard.beforeSend(session.session_id);
    if (decision.action === "skip") {
      // A session the server has forgotten stays forgotten: tear it down instead
      // of letting the 30s timer keep firing dead signals.
      if (decision.reason === "terminal" && isCurrent()) tearDownDesktopDeliverySignal(session.session_id);
      return;
    }

    const { apiFetch, DesktopApiError } = await import("../auth.js");
    if (!isCurrent()) return;
    const deliverySignalSequence = nextDesktopDeliverySignalSequence(runtime);
    const path = roomClosed
      ? `/rooms/${encodeURIComponent(session.room_id)}/agent-sessions/${encodeURIComponent(session.session_id)}/desktop-pause`
      : `/rooms/${encodeURIComponent(session.room_id)}/agent-sessions/${encodeURIComponent(session.session_id)}/desktop-heartbeat`;
    const body = roomClosed
      ? {
          agent_session_id: session.session_id,
          agent_session_token: session.session_token,
          status_text: "Room is not open on the managing desktop",
          availability: "room_closed",
          delivery_signal_sequence: deliverySignalSequence,
        }
      : {
          agent_session_id: session.session_id,
          agent_session_token: session.session_token,
          delivery_signal_sequence: deliverySignalSequence,
        };
    try {
      await apiFetch<Record<string, unknown>>(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-LetAgents-Desktop-Client": "1" },
        body: JSON.stringify(body),
      });
      if (!isCurrent()) return;
      if (roomClosed) desktopDeliverySignalGuard.recordSuccess(session.session_id, "room_closed");
      else desktopDeliverySignalGuard.recordSuccess(session.session_id);
      const supervisorEntryId = supervisorEntryIdForAgentSession(session.session_id);
      if (supervisorEntryId) {
        const { supervisorDaemonClient } = await import("../supervisor-daemon.js");
        await supervisorDaemonClient.updateWorkplaceLiveness(
          supervisorEntryId,
          "reachable",
          roomClosed ? "Room channel reachable; delivery intentionally paused while the room is closed." : "Room heartbeat accepted.",
        ).catch(() => undefined);
      }
    } catch (error) {
      if (!isCurrent()) return;
      const status = error instanceof DesktopApiError ? error.status : null;
      if (reconcileDesktopDeliverySignalSequence(runtime, error)) {
        if (isCurrent()) {
          setImmediate(() => {
            void postDesktopManagedWorkerDeliveryHeartbeat(session, streamRoomIdentifier)
              .catch(() => undefined);
          });
        }
        return;
      }
      const terminal = desktopDeliverySignalGuard.recordFailure(session.session_id, status).terminal;
      const supervisorEntryId = supervisorEntryIdForAgentSession(session.session_id);
      if (supervisorEntryId) {
        const { supervisorDaemonClient } = await import("../supervisor-daemon.js");
        await supervisorDaemonClient.updateWorkplaceLiveness(
          supervisorEntryId,
          terminal ? "stale" : "unknown",
          terminal ? "Room session is no longer accepted; native execution is evaluated independently." : "Room heartbeat failed; reachability is unknown.",
        ).catch(() => undefined);
      }
      if (terminal && isCurrent()) {
        tearDownDesktopDeliverySignal(session.session_id);
      }
    }
  });
}

export function startDesktopManagedWorkerDeliveryHeartbeat(
  session: StoredAgentSessionState,
  streamRoomIdentifier = session.room_id,
): void {
  stopDesktopManagedWorkerDeliveryHeartbeat(session.session_id);
  // A genuine (re)start / resume earns a clean slate so a session that recovered
  // can signal again even after an earlier terminal stop.
  restartDesktopDeliverySignalState(session.session_id);
  desktopDeliverySignalGuard.reset(session.session_id);
  void postDesktopManagedWorkerDeliveryHeartbeat(session, streamRoomIdentifier).catch(() => undefined);
  const timer = setInterval(() => {
    void postDesktopManagedWorkerDeliveryHeartbeat(session, streamRoomIdentifier).catch(() => undefined);
  }, DESKTOP_DELIVERY_HEARTBEAT_MS);
  timer.unref?.();
  desktopDeliveryHeartbeatTimers.set(session.session_id, timer);
}

export async function pauseDesktopManagedWorkerDelivery(
  session: StoredAgentSessionState,
  statusText: string,
): Promise<void> {
  stopDesktopManagedWorkerDeliveryHeartbeat(session.session_id);
  const desiredState = `failure:${statusText}`;
  const runtime = selectDesktopDeliverySignalState(session.session_id, desiredState);
  if (!(await shouldUseCloudDesktopManagedAgentWorkerSession(session))) return;
  if (!runtime.lane.isCurrent(runtime.generation)) return;
  await runtime.lane.run(runtime.generation, desiredState, async (isCurrent) => {
    // onSessionUnavailable fires this per failed turn, so without the guard a run
    // of failures (or a server that 404s the endpoint) becomes a pause storm.
    const decision = desktopDeliverySignalGuard.beforeSend(session.session_id);
    if (decision.action === "skip") {
      if (decision.reason === "terminal" && isCurrent()) markAgentSessionEnded(session.session_id);
      return;
    }

    const { apiFetch, DesktopApiError } = await import("../auth.js");
    if (!isCurrent()) return;
    const deliverySignalSequence = nextDesktopDeliverySignalSequence(runtime);
    try {
      await apiFetch<Record<string, unknown>>(
        `/rooms/${encodeURIComponent(session.room_id)}/agent-sessions/${encodeURIComponent(session.session_id)}/desktop-pause`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-LetAgents-Desktop-Client": "1" },
          body: JSON.stringify({
            agent_session_id: session.session_id,
            agent_session_token: session.session_token,
            status_text: statusText,
            availability: "failure",
            delivery_signal_sequence: deliverySignalSequence,
          }),
        },
      );
      if (isCurrent()) desktopDeliverySignalGuard.recordSuccess(session.session_id);
    } catch (error) {
      if (!isCurrent()) return;
      const status = error instanceof DesktopApiError ? error.status : null;
      if (reconcileDesktopDeliverySignalSequence(runtime, error)) {
        if (isCurrent()) {
          setImmediate(() => {
            void pauseDesktopManagedWorkerDelivery(session, statusText).catch(() => undefined);
          });
        }
        return;
      }
      if (desktopDeliverySignalGuard.recordFailure(session.session_id, status).terminal && isCurrent()) {
        markAgentSessionEnded(session.session_id);
      }
    }
  });
}

export async function disconnectDesktopManagedWorker(
  session: StoredAgentSessionState | null,
): Promise<void> {
  if (!session?.session_id || !session.session_token) {
    return;
  }
  stopDesktopManagedWorkerDeliveryHeartbeat(session.session_id);
  const runtime = selectDesktopDeliverySignalState(session.session_id, "disconnect");
  desktopDeliverySignalGuard.forget(session.session_id);

  await runtime.lane.run(runtime.generation, "disconnect", async (isCurrent) => {
    if (!(await shouldUseCloudDesktopManagedAgentWorkerSession(session))) {
      if (isCurrent()) markAgentSessionEnded(session.session_id);
      return;
    }
    if (!isCurrent()) return;

    try {
      const { apiFetch } = await import("../auth.js");
      if (!isCurrent()) return;
      await apiFetch<Record<string, unknown>>(
        `/rooms/${encodeURIComponent(session.room_id)}/agent-sessions/${encodeURIComponent(session.session_id)}/disconnect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent_session_id: session.session_id,
            agent_session_token: session.session_token,
          }),
        },
      );
    } catch {
      // Local cleanup still matters; the next room snapshot will reconcile any server-side state.
    } finally {
      if (isCurrent()) markAgentSessionEnded(session.session_id);
      retireDesktopDeliverySignalRuntimeAfterDrain(session.session_id, runtime);
    }
  });
}

export function managedAgentWorkerReplyTargetForEvent(event: ManagedRoomEvent): DesktopManagedAgentReplyTarget {
  if (event.type !== "message") {
    return { replyTo: null, threadRootId: null };
  }
  return desktopManagedAgentReplyTargetForMessage(event.message);
}

export async function publishDesktopManagedWorkerReply(input: {
  provider: ManagedAgentWorkerProvider;
  sessionToken: string;
  agentSessionId: string | null | undefined;
  sessionKey: string;
  /** Deferred so the public-session mapping only runs once the guards pass. */
  publicSession: () => DesktopManagedAgentSession;
  roomIdentifier: string;
  storage: DesktopRoomStorageState;
  event: ManagedRoomEvent;
  text: string | null;
  beforeChangeSignature?: string | null;
  onMissingWorkerSession: () => void;
}): Promise<void> {
  const text = desktopEventPublicReplyText(input.sessionToken, input.text);
  if (!text) {
    return;
  }

  const workerSession = getStoredAgentSession(input.agentSessionId);
  if (!workerSession?.session_id || !workerSession.session_token) {
    input.onMissingWorkerSession();
    return;
  }

  const replyTarget = managedAgentWorkerReplyTargetForEvent(input.event);
  const changeContext = await buildDesktopManagedAgentReplyChangeContext({
    sessionKey: input.sessionKey,
    session: input.publicSession(),
    beforeSignature: input.beforeChangeSignature ?? null,
  });
  if (input.storage.effectiveMode === "local") {
    // The message INSERT advances the durable delivery sequence, so the local
    // workflow artifact must share that SQLite transaction. Once the commit is
    // visible, every poll and in-process wake observes both records together.
    const preparedArtifact = await prepareDesktopManagedAgentReplyChangeSummaryArtifactWrite({
      sessionKey: input.sessionKey,
      roomIdentifier: input.roomIdentifier,
      storage: input.storage,
      workerSession,
      event: input.event,
      context: changeContext,
    });
    const localReply = await persistDesktopManagedAgentLocalReplyWithDeferredWriteNotification({
      roomIdentifier: input.roomIdentifier,
      storage: input.storage,
      workerSession,
      replyTo: replyTarget.replyTo,
      threadRootId: replyTarget.threadRootId,
      text,
      attachments: localDesktopManagedAgentReplyChangeAttachments(changeContext),
      writeInTransaction: preparedArtifact
        ? (database) => {
            if (database !== preparedArtifact.database) {
              throw new Error("Local reply and workflow artifact must share one SQLite transaction.");
            }
            preparedArtifact.writeInCurrentTransaction();
          }
        : undefined,
    });
    if (!localReply) {
      throw new Error("Local managed-agent reply was not persisted in local storage.");
    }
    await preparedArtifact?.finalizeAfterCommit();
    localReply.publishWriteNotification();
    rememberDesktopManagedAgentReplyChangeAttachment(input.sessionKey, changeContext.attachmentDraft);
    return;
  }

  const { apiFetch } = await import("../auth.js");
  const { cloudRoomIdentifierForStorage } = await import("../rooms/local-store.js");
  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(input.storage, input.roomIdentifier);
  const attachments = await stageDesktopManagedAgentReplyChangeAttachment(
    cloudRoomIdentifier,
    changeContext.attachmentDraft,
  );
  if (changeContext.attachmentDraft && attachments.length === 0) {
    console.warn(`Could not attach ${input.provider.replyWarnLabel} managed-agent working tree summary to room reply.`);
  }
  await apiFetch<Record<string, unknown>>(
    `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LetAgents-Desktop-Client": "1",
      },
      body: JSON.stringify({
        text,
        reply_to: replyTarget.replyTo,
        thread_root_id: replyTarget.threadRootId,
        agent_session_id: workerSession.session_id,
        agent_session_token: workerSession.session_token,
        attachments,
      }),
    },
  );
  if (changeContext.attachmentDraft && attachments.length > 0) {
    rememberDesktopManagedAgentReplyChangeAttachment(input.sessionKey, changeContext.attachmentDraft);
  }
  await publishDesktopManagedAgentReplyChangeSummaryArtifact({
    sessionKey: input.sessionKey,
    roomIdentifier: input.roomIdentifier,
    storage: input.storage,
    workerSession,
    event: input.event,
    context: changeContext,
  });
}

export async function publishDesktopManagedWorkerFailure(input: {
  session: DesktopManagedLiveSessionBase;
  storage: DesktopRoomStorageState;
  event: ManagedRoomEvent;
  failure: DesktopManagedAgentFailure;
}): Promise<void> {
  const workerSession = getStoredAgentSession(input.session.agent_session_id);
  if (!workerSession?.session_id || !workerSession.session_token) return;

  const displayName = workerSession.display_name?.trim() || "The managed agent";
  const text = `${displayName} could not reply: ${input.failure.message}`;
  const localMessage = await persistDesktopManagedAgentLocalReply({
    roomIdentifier: input.session.room_identifier,
    storage: input.storage,
    workerSession,
    replyTo: null,
    text,
    source: "managed_agent_failure",
    sender: "letagents",
    idempotencyKey: `managed_agent_failure:${workerSession.session_id}:${input.failure.eventId || "turn"}:${input.failure.code}`,
  });
  if (localMessage) {
    return;
  }

  const { apiFetch } = await import("../auth.js");
  const { cloudRoomIdentifierForStorage } = await import("../rooms/local-store.js");
  const cloudRoomIdentifier = cloudRoomIdentifierForStorage(input.storage, input.session.room_identifier);
  try {
    await apiFetch<Record<string, unknown>>(
      `/rooms/${encodeURIComponent(cloudRoomIdentifier)}/agent-sessions/${encodeURIComponent(workerSession.session_id)}/failures`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-LetAgents-Desktop-Client": "1" },
        body: JSON.stringify({
          agent_session_id: workerSession.session_id,
          agent_session_token: workerSession.session_token,
          code: input.failure.code,
          origin_event_id: input.failure.eventId,
        }),
      },
    );
  } finally {
    await pauseDesktopManagedWorkerDelivery(workerSession, input.failure.message).catch(() => undefined);
  }
}

export function normalizeAgentIdentityName(displayName: string, fallback: string): string {
  const normalized = displayName
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || fallback;
}

export function normalizeDisplayText(value: string | null | undefined, fallback: string): string {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  return normalized || fallback;
}

export function formatOwnerAttribution(ownerLabel: string): string {
  const normalized = normalizeDisplayText(ownerLabel, "Owner");
  return /s$/i.test(normalized) ? `${normalized}' agent` : `${normalized}'s agent`;
}

export function buildAgentActorLabel(input: {
  displayName: string;
  ownerLabel: string;
  ideLabel: string;
}): string {
  return [
    normalizeDisplayText(input.displayName, "Agent"),
    formatOwnerAttribution(input.ownerLabel),
    normalizeDisplayText(input.ideLabel, "Agent"),
  ].join(" | ");
}

export function isUsableAgentIdentity(
  identity: StoredAgentIdentityState | null,
): identity is StoredAgentIdentityState {
  return Boolean(identity?.canonical_key?.trim());
}

import type {
  DesktopRoomAgentCausalEvent,
  DesktopRoomSharedArtifact,
  DesktopSupervisorAgentInspectorDetail,
  DesktopSupervisorManifestEntry,
  DesktopSupervisorStateSnapshot,
  DesktopTaskSummary,
} from "../../../electron/ipc-types";
import { roomArtifactTimelineItems, type RoomArtifactTimelineItem } from "./room-artifacts";
import type { RetainedExecutionDetail } from "../../../shared/execution-protocol";

type RecordedTurn = Extract<RetainedExecutionDetail, { availability: "available" }>["turns"][number];
type RuntimeControl = NonNullable<DesktopSupervisorAgentInspectorDetail["runtime_control"]>;

export interface AgentInspectorRuntimeControlPresentation {
  state: RuntimeControl["control_state"] | "stopping" | "exited";
  label: string;
  detail: string;
  observedAt: string | null;
}

export function agentInspectorRuntimeControlMatchesFence(
  control: RuntimeControl | null | undefined,
  executionGenerationId: string | null,
  daemonGeneration: number | null,
  runtimeGenerationId?: string | null,
): boolean {
  return Boolean(control
    && executionGenerationId
    && control.execution_generation_id === executionGenerationId
    && Number(control.daemon_generation_id) === daemonGeneration
    && runtimeGenerationId?.trim()
    && control.runtime_generation_id === runtimeGenerationId);
}

/** Durable work changes refresh promptly; liveness timestamps do not. */
export function agentInspectorDetailRevision(entry: DesktopSupervisorManifestEntry): string {
  return JSON.stringify([entry.observedState, entry.condition, entry.lastError,
    entry.workAttemptId, entry.providerContinuationId, entry.lastTurnControlSequence,
    entry.roomAgentState?.inbox, entry.roomAgentState?.turn, entry.roomAgentState?.task,
    entry.deliveryReceipts, entry.turnControl, entry.lastTerminal]);
}

export function agentInspectorDetailKey(entry: DesktopSupervisorManifestEntry, source: string | null, generation: number): string {
  return JSON.stringify([entry.id, entry.roomId, source, entry.executionGenerationId, generation, entry.runtimeGenerationId ?? null]);
}

export function agentInspectorDetailRequestIsCurrent(key: string, token: number, current: {
  entry: DesktopSupervisorManifestEntry | null | undefined; roomId: string; source: string | null;
  generation: number | null; snapshotGeneration: number; token: number;
}): boolean {
  return Boolean(current.entry && current.entry.roomId === current.roomId && token === current.token
    && current.generation !== null && current.snapshotGeneration <= current.generation
    && agentInspectorDetailKey(current.entry, current.source, current.generation) === key);
}

export function invalidateAgentInspectorRuntimeControl(resource: AgentInspectorWorkResource,
  snapshot: DesktopSupervisorStateSnapshot, entryId: string, roomId: string): AgentInspectorWorkResource {
  const entry = snapshot.entries.find(candidate => candidate.id === entryId);
  const detail = resource.detail;
  if (detail?.runtime_control && (!entry || entry.roomId !== roomId || !agentInspectorRuntimeControlMatchesFence(
    detail.runtime_control, entry.executionGenerationId, snapshot.daemonGeneration, entry.runtimeGenerationId ?? null))) {
    return { ...resource, detail: { ...detail, runtime_control: null } };
  }
  return resource;
}

/** Retain exact history during a refresh, but never retain unfenced health. */
export async function readAgentInspectorWorkDetail(input: {
  entry: DesktopSupervisorManifestEntry; source: string | null; generation: number;
  previous: AgentInspectorWorkResource;
  read: () => Promise<DesktopSupervisorAgentInspectorDetail>;
  isCurrent: () => boolean;
  write: (resource: AgentInspectorWorkResource) => void;
}): Promise<DesktopSupervisorAgentInspectorDetail | null> {
  const { entry, source, generation } = input;
  const fenceHealth = (detail: DesktopSupervisorAgentInspectorDetail) => detail.runtime_control
    && !agentInspectorRuntimeControlMatchesFence(detail.runtime_control, entry.executionGenerationId, generation, entry.runtimeGenerationId ?? null)
    ? { ...detail, runtime_control: null } : detail;
  const cached = input.previous.detail;
  const previous = input.previous.sourceMessageId === source && cached
    && isCurrentAgentInspectorWorkResponse(cached, entry.id, entry.roomId, source) ? fenceHealth(cached) : null;
  input.write({ status: previous ? "refreshing" : "loading", detail: previous, error: null, sourceMessageId: source });
  try {
    const detail = await input.read();
    if (!input.isCurrent() || !isCurrentAgentInspectorWorkResponse(detail, entry.id, entry.roomId, source)) return null;
    const current = fenceHealth(detail);
    input.write({ status: "ready", detail: current, error: null, sourceMessageId: source });
    return current;
  } catch (error) {
    if (input.isCurrent()) input.write({ status: "error", detail: previous ? { ...previous, runtime_control: null } : null,
      error: error instanceof Error ? error.message : "Could not load retained work.", sourceMessageId: source });
    return null;
  }
}

/** Collapse background bursts without starving a same-runtime response. */
export function createAgentInspectorBackgroundRefresh(now: () => number = Date.now) {
  type Request = { key: string; revision: string; run: () => Promise<boolean> };
  let active: (Request & { next: Request | null; promise: Promise<void> }) | null = null;
  let completed: { key: string; revision: string; at: number } | null = null;
  const refresh = (key: string, revision: string, run: Request["run"]): Promise<void> => {
    if (active?.key === key) {
      active.next = active.revision !== revision ? { key, revision, run } : null;
      return active.promise;
    }
    if (completed && completed.key !== key) completed = null;
    // Health can change without manifest changes. Recheck at least every five
    // seconds while snapshots arrive, even when this entry is unchanged.
    if (completed?.key === key && completed.revision === revision && now() - completed.at < 5_000) return Promise.resolve();
    const request = { key, revision, run, next: null as Request | null, promise: Promise.resolve() };
    active = request;
    request.promise = Promise.resolve().then(run).catch(() => false).then(async success => {
      if (active !== request) return;
      if (success) completed = { key, revision, at: now() };
      const next = request.next;
      active = null;
      if (next) await refresh(next.key, next.revision, next.run);
    });
    return request.promise;
  };
  return { refresh, reset() { active = null; completed = null; } };
}

export function createAgentInspectorDetailRequest() {
  let active: { key: string; followDefaultSource: boolean; promise: Promise<void> } | null = null;
  return {
    run(key: string, followDefaultSource: boolean, read: (intent: { followDefaultSource: boolean }) => Promise<void>): Promise<void> {
      if (active?.key === key) {
        active.followDefaultSource ||= followDefaultSource;
        return active.promise;
      }
      const request = { key, followDefaultSource, promise: Promise.resolve() };
      active = request;
      request.promise = read(request).finally(() => { if (active === request) active = null; });
      return request.promise;
    },
    reset() { active = null; },
  };
}

/** Control health explains reachability only; it never claims work succeeded or failed. */
export function describeAgentInspectorRuntimeControl(
  control: RuntimeControl | null | undefined,
): AgentInspectorRuntimeControlPresentation | null {
  if (!control) return null;
  if (control.runtime_state === "exited") return {
    state: "exited",
    label: "Provider stopped",
    detail: "The provider runtime exited. LetAgents will not infer that unfinished work completed.",
    observedAt: control.observed_at,
  };
  if (control.runtime_state === "stopping") return {
    state: "stopping",
    label: "Provider stopping",
    detail: "LetAgents is ending this provider runtime.",
    observedAt: control.observed_at,
  };
  const presentation: Record<RuntimeControl["control_state"], Pick<AgentInspectorRuntimeControlPresentation, "label" | "detail">> = {
    connecting: {
      label: control.runtime_state === "starting" ? "Provider starting" : "Checking provider",
      detail: "LetAgents is verifying the provider’s control connection.",
    },
    responsive: {
      label: "Provider reachable at last check",
      detail: "The latest control check completed.",
    },
    degraded: {
      label: "Provider check inconclusive",
      detail: "LetAgents could not confirm the provider’s control connection. The agent may still be working; it has not been failed or restarted.",
    },
    lost: {
      label: "Provider connection lost",
      detail: "Process or transport evidence shows that LetAgents can no longer control this provider runtime.",
    },
    unprobeable: {
      label: "Live checks unavailable",
      detail: "This provider has no safe control probe. Silence is not treated as failure.",
    },
  };
  return { state: control.control_state, ...presentation[control.control_state], observedAt: control.observed_at };
}

/** Recorded native evidence is not a current running-state or delivery claim. */
export function humanizeRecordedTurn(turn: RecordedTurn): string {
  if (turn.outcome === "completed") return "Provider turn completed";
  if (turn.outcome === "failed") return "Provider turn failed";
  if (turn.outcome === "interrupted") return "Provider turn interrupted";
  if (turn.outcome === "unreadable") return "Provider result unreadable";
  return turn.state === "lost" ? "Provider turn lost" : "No turn finish recorded";
}

export function describeRecordedOperation(row: RecordedTurn["operations"][number]): { title: string; detail: string } {
  const operations = { command: "Command", file_read: "File read", file_change: "File edit", network: "Network request", question: "Question", other: "Operation" };
  const outcomes = { succeeded: "Completed", failed: "Failed", denied_before_start: "Denied before starting", cancelled_before_start: "Cancelled before starting", interrupted_after_start: "Interrupted after starting", lost_after_start: "Outcome lost after starting" };
  const notes: string[] = [];
  if (row.exitCode !== null) notes.push(`Exit code ${row.exitCode}`);
  if (row.signalNumber !== null) notes.push(`Signal ${row.signalNumber}`);
  if (row.outputBytes > 0) notes.push(`${row.outputBytes.toLocaleString()} bytes of output recorded`);
  if (row.sideEffects !== "none") notes.push(row.sideEffects === "observed" ? "Side effects observed" : "Side effects possible");
  if (!row.startObserved && row.outcome !== "denied_before_start" && row.outcome !== "cancelled_before_start") notes.push("Start was not recorded");
  return { title: `${operations[row.operation]} · ${row.outcome === null ? "No finish recorded" : outcomes[row.outcome]}`, detail: notes.join(" · ") };
}

export type AgentInspectorWorkResource = {
  status: "idle" | "loading" | "refreshing" | "ready" | "unavailable" | "error";
  detail: DesktopSupervisorAgentInspectorDetail | null;
  error: string | null;
  sourceMessageId: string | null;
};

export function emptyAgentInspectorWorkResource(): AgentInspectorWorkResource {
  return { status: "idle", detail: null, error: null, sourceMessageId: null };
}

/** A detail response is usable only when every durable routing fence agrees. */
export function isCurrentAgentInspectorWorkResponse(
  detail: DesktopSupervisorAgentInspectorDetail,
  entryId: string,
  roomId: string,
  sourceMessageId: string | null,
): boolean {
  return detail.entry_id === entryId
    && detail.room_id === roomId
    && detail.requested_source_message_id === sourceMessageId
    && (sourceMessageId === null
      ? detail.availability === "not_loaded" && detail.source_message === null
      : (detail.availability !== "available" || detail.source_message?.id === sourceMessageId));
}

/** The active turn wins; otherwise the daemon's bounded newest-first list wins. */
export function defaultAgentInspectorWorkSource(
  entry: Pick<DesktopSupervisorManifestEntry, "roomAgentState">,
  detail: Pick<DesktopSupervisorAgentInspectorDetail, "items"> | null,
): string | null {
  const active = entry.roomAgentState?.turn.sourceMessageId?.trim();
  return active || detail?.items[0]?.source_message_id || null;
}

export function humanizeAgentInspectorReceiptState(state: string, terminalReason: string | null = null): string {
  if (terminalReason === "upgrade_authority_unavailable") return "Retired during a safety upgrade";
  const labels: Record<string, string> = {
    pending: "Waiting to start", dispatching: "Starting work", awaiting_result: "Working",
    result_recovery: "Recovering the result", publishing: "Publishing reply",
    acknowledged: "Reply published", acknowledged_no_reply: "No reply needed",
    acknowledged_failed: "Work did not finish",
    retryable: "Ready to retry", blocked: "Needs attention",
    cancelled_by_room_move: "Cancelled after room move",
    cancelled_by_user: "Skipped by you",
    restoring_conversation: "Restoring conversation",
  };
  return labels[state] || "Recorded work";
}

export function describeAgentInspectorUncertainEffect(toolName: string): string {
  return `${toolName} may have completed before its result was saved. Verify external state before repeating it.`;
}

export function humanizeAgentInspectorTimeline(event: DesktopRoomAgentCausalEvent): string {
  const labels: Record<DesktopRoomAgentCausalEvent["phase"], string> = {
    received: "Message received", queued: "Work queued", turn_started: "Work started",
    turn_finished: "Work finished", result_unreadable: "Result needs recovery",
    publish_started: "Reply publication started", published: "Reply published",
    no_reply: "No reply was needed", retry_scheduled: "Retry scheduled",
    blocked: "Work needs attention", room_move_cancelled: "Cancelled after room move",
    conversation_restoring: "Conversation restoration started",
    conversation_restored: "Conversation restored",
    user_cancelled: "Message skipped by you",
  };
  return labels[event.phase];
}

/** Task and artifact linkage is by IDs supplied by the durable projections only. */
export function agentInspectorWorkArtifacts(
  tasks: readonly Pick<DesktopTaskSummary, "id">[],
  artifacts: readonly DesktopRoomSharedArtifact[],
): RoomArtifactTimelineItem[] {
  const taskIds = new Set(tasks.map((task) => task.id));
  return roomArtifactTimelineItems(artifacts).filter((item) =>
    item.artifact.linkedTaskIds.some((id) => taskIds.has(id)),
  );
}

import type {
  DesktopSupervisorLaunchPhase,
  DesktopSupervisorLaunchProgress,
  DesktopSupervisorManifestEntry,
} from "../../../electron/ipc-types";
import { avatarInitials } from "../../../../../shared/chat-appearance";
import { supervisedAgentDisplayLabel } from "./codenames";
import { startRefusalReason } from "./agent-home-harness";
import { supervisedLaunchProgress } from "./supervised-launch";
import { thisComputerLabel } from "./supervised-agents-support";

/**
 * The start-up row a person sees in the room timeline after they start an
 * agent. It tells the daemon's real launch phases (see
 * daemon/launch-progress.ts) in plain words:
 *
 *   prepare            -> Checking sign-in and settings (with the saved agent's
 *                         workspace set-up before the launch)
 *   slot_wait          -> Waiting for a free start slot (only when it waited)
 *   admission, process -> Starting Claude Code | Codex | OpenCode
 *   bootstrap          -> Connecting to <model> (Claude Code only; other
 *                         providers count it as part of their start)
 *   install + bind     -> Joining #room (until the agent is bound and reachable)
 *   first output       -> Reading the room (until the agent's first visible output)
 *
 * Without daemon progress (an older daemon, or after a daemon restart) the
 * stages follow the manifest milestones alone.
 */

export type AgentStartupStageKey = "prepare" | "slot" | "process" | "bootstrap" | "join" | "context";
export type AgentStartupStageState = "pending" | "now" | "done" | "failed";
export type AgentStartupStatus = "running" | "joined" | "failed" | "cancelled";
export type AgentStartupAction = "sign_in" | "install" | "retry";

export interface AgentStartupStage {
  key: AgentStartupStageKey;
  label: string;
  state: AgentStartupStageState;
  /** Measured time of a finished stage; null while it runs or when unknown. */
  ms: number | null;
}

export interface AgentStartupView {
  entryId: string;
  name: string;
  initials: string;
  providerLabel: string;
  status: AgentStartupStatus;
  stages: AgentStartupStage[];
  /** One line under the name. */
  line: string;
  /** Finished stages over all stages, for the avatar ring. */
  fraction: number;
  /** The elapsed timer counts from here (ms since the epoch). */
  timerStartMs: number;
  /** Where the timer stops; null while running. */
  timerEndMs: number | null;
  failure: { reason: string; action: AgentStartupAction } | null;
}

export interface AgentStartupContext {
  roomLabel: string;
  /** Chosen effort, when the starting surface knows it (the manifest does not carry it). */
  effort?: string | null;
  /** The person asked to try again at this time; a failure older than this is not shown. */
  retryRequestedAtMs?: number | null;
  /** The person cancelled; shown until the daemon confirms the stop. */
  cancelRequested?: boolean;
}

type Entry = Pick<DesktopSupervisorManifestEntry,
  | "id" | "displayName" | "provider" | "model" | "permissionProfileId" | "createdAt" | "readyReachedAt"
  | "desiredState" | "observedState" | "condition" | "lastError" | "launchProgress" | "providerProgress"
  | "workspacePath" | "providerPid" | "providerContinuationId" | "executionGenerationId" | "agentSessionId"
  | "agentSessionBindingState" | "workplaceLiveness">;

/** The runtime's own name, which is what starts on this computer. */
export function agentRuntimeLabel(provider: string): string {
  switch (provider.trim().toLowerCase()) {
    case "claude":
    case "claude-code": return "Claude Code";
    case "codex": return "Codex";
    case "open-model":
    case "open_model": return "OpenCode";
    case "cursor": return "Cursor";
    case "antigravity": return "Antigravity";
    default: return provider.trim() || "the agent";
  }
}

const ACCESS_LABELS: Record<string, string> = {
  read_only: "Read-only",
  ask_before_write: "Ask before writes",
  auto_review: "Auto",
  sandboxed_write: "Sandboxed writes",
  full_access: "Full access",
};

function accessLabel(entry: Pick<Entry, "provider" | "permissionProfileId">): string | null {
  const id = entry.permissionProfileId;
  if (!id) return null;
  if (id === "sandboxed_write" && entry.provider === "cursor") return "Workspace writes";
  return ACCESS_LABELS[id] ?? null;
}

function isClaude(provider: string): boolean {
  return provider === "claude-code" || provider === "claude";
}

/** The stage a daemon launch phase belongs to, for this provider. */
export function stageForLaunchPhase(phase: DesktopSupervisorLaunchPhase, provider: string): AgentStartupStageKey {
  switch (phase) {
    case "prepare": return "prepare";
    case "slot_wait": return "slot";
    case "admission":
    case "process": return "process";
    case "bootstrap": return isClaude(provider) ? "bootstrap" : "process";
    case "install": return "join";
  }
}

/** How long "Reading the room" waits for a first output before the agent counts as joined. */
const READING_MAX_MS = 60_000;

/** How long a retry may wait for the daemon's next launch before an unchanged failure shows again. */
const RETRY_PENDING_MAX_MS = 20_000;

/** A slot wait shorter than this was not a wait a person would notice. */
const SLOT_WAIT_SHOWN_MS = 500;

function stageLabel(key: AgentStartupStageKey, entry: Entry, roomLabel: string): string {
  switch (key) {
    case "prepare": return "Checking sign-in and settings";
    case "slot": return "Waiting for a free start slot";
    case "process": return `Starting ${agentRuntimeLabel(entry.provider)}`;
    case "bootstrap": return `Connecting to ${entry.model?.trim() || "the model"}`;
    case "join": return `Joining ${roomLabel}`;
    case "context": return "Reading the room";
  }
}

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function seconds(ms: number): string {
  const value = Math.max(0, ms) / 1000;
  return value < 10 ? `${value.toFixed(1)}s` : `${Math.round(value)}s`;
}

/** Plain stage line text while a stage runs. */
function slotNote(ahead: number | null): string | null {
  if (!ahead || ahead < 1) return null;
  return ahead === 1 ? "1 agent is starting first" : `${ahead} agents are starting first`;
}

function failureReason(action: AgentStartupAction, entry: Entry): string {
  const runtime = agentRuntimeLabel(entry.provider);
  if (action === "sign_in") return `${runtime} is not signed in on ${thisComputerLabel()}.`;
  if (action === "install") return `${runtime} could not be found on ${thisComputerLabel()}.`;
  return safeManifestDetail(supervisedLaunchProgress(entry).failureDetail);
}

/** Scheduler internals are no reason a person can act on. */
function safeManifestDetail(detail: string | null): string {
  const refusal = startRefusalReason(detail);
  if (refusal) return refusal;
  if (!detail?.trim() || /convergence scheduler failure|scheduler failure:/i.test(detail)) return "The start did not finish.";
  return detail;
}

function manifestFailureAction(entry: Entry): AgentStartupAction {
  if (entry.condition === "auth_blocked") return "sign_in";
  if (/\bspawn\b.*\bENOENT\b/i.test(entry.lastError ?? "")) return "install";
  return "retry";
}

type StageFacts = { done: boolean; ms: number | null; startMs: number | null };

/**
 * Per-stage facts from the daemon launch progress and the manifest. A stage is
 * done only on evidence; the first stage that is not done is the current one.
 */
function stageFacts(entry: Entry, progress: DesktopSupervisorLaunchProgress | null, nowMs: number): Map<AgentStartupStageKey, StageFacts> {
  const facts = new Map<AgentStartupStageKey, StageFacts>();
  const createdMs = time(entry.createdAt);
  const readyMs = time(entry.readyReachedAt);
  const firstOutputMs = time(progress?.firstOutputAt);
  const set = (key: AgentStartupStageKey, value: StageFacts) => facts.set(key, value);

  if (!progress) {
    // Manifest milestones only: the process exists, then the agent is ready.
    const processUp = entry.provider === "cursor" ? entry.providerContinuationId != null : entry.providerPid != null;
    const ready = readyMs != null;
    set("prepare", { done: processUp || ready || entry.workspacePath != null, ms: null, startMs: createdMs });
    set("process", { done: processUp || ready, ms: null, startMs: null });
    // The manifest cannot tell the bootstrap apart from the process start.
    set("bootstrap", { done: processUp || ready, ms: null, startMs: null });
    set("join", { done: ready, ms: null, startMs: null });
    // With no daemon progress there is no first-output evidence; ready is the end.
    set("context", { done: ready, ms: null, startMs: null });
    return facts;
  }

  const phases = progress.phases;
  const sumOf = (key: AgentStartupStageKey): { ms: number | null; closed: boolean; startMs: number | null; seen: boolean } => {
    const own = phases.filter((phase) => stageForLaunchPhase(phase.phase, entry.provider) === key);
    if (!own.length) return { ms: null, closed: false, startMs: null, seen: false };
    const closed = own.every((phase) => phase.ms != null);
    return {
      ms: closed ? own.reduce((sum, phase) => sum + (phase.ms ?? 0), 0) : null,
      closed,
      startMs: time(own[0]!.startedAt),
      seen: true,
    };
  };
  const launchStartMs = time(progress.startedAt);
  const prepare = sumOf("prepare");
  // Before this launch the saved agent's workspace was set up; that counts as preparing.
  const prepareStartMs = progress.attempt === 1 && createdMs != null && launchStartMs != null && createdMs <= launchStartMs
    && launchStartMs - createdMs < 10 * 60_000 ? createdMs : launchStartMs;
  const prepareEnd = prepare.closed && prepare.startMs != null && prepare.ms != null ? prepare.startMs + prepare.ms : null;
  set("prepare", {
    done: prepare.closed,
    ms: prepareEnd != null && prepareStartMs != null ? prepareEnd - prepareStartMs : prepare.ms,
    startMs: prepareStartMs,
  });
  const slot = sumOf("slot");
  set("slot", { done: slot.closed, ms: slot.ms, startMs: slot.startMs });
  const processStage = sumOf("process");
  // Each phase opens when the one before it closes, so a closed stage has nothing of it still running.
  set("process", { done: processStage.closed, ms: processStage.ms, startMs: processStage.startMs });
  const bootstrap = sumOf("bootstrap");
  const pastBootstrap = phases.some((phase) => phase.phase === "install");
  set("bootstrap", { done: bootstrap.closed || pastBootstrap, ms: bootstrap.ms, startMs: bootstrap.startMs });
  const install = sumOf("join");
  const launched = progress.state === "launched";
  const joinEndMs = launched && readyMs != null && progress.endedAt ? Math.max(readyMs, time(progress.endedAt) ?? readyMs) : null;
  set("join", {
    done: joinEndMs != null,
    ms: joinEndMs != null && install.startMs != null ? Math.max(0, joinEndMs - install.startMs) : null,
    startMs: install.startMs,
  });
  // An agent with nothing to say yet has still joined; the room is read by then.
  const contextDone = joinEndMs != null && (firstOutputMs != null || nowMs - joinEndMs >= READING_MAX_MS);
  set("context", {
    done: contextDone,
    ms: contextDone && firstOutputMs != null ? Math.max(0, firstOutputMs - joinEndMs) : null,
    startMs: joinEndMs,
  });
  return facts;
}

function showsSlot(progress: DesktopSupervisorLaunchProgress | null, nowMs: number): boolean {
  const wait = progress?.phases.find((phase) => phase.phase === "slot_wait");
  if (!wait) return false;
  if (wait.ms != null) return wait.ms >= SLOT_WAIT_SHOWN_MS;
  if ((progress?.slotAhead ?? 0) > 0) return true;
  const started = time(wait.startedAt);
  return started != null && nowMs - started >= SLOT_WAIT_SHOWN_MS;
}

export function agentStartupView(entry: Entry, context: AgentStartupContext, nowMs: number): AgentStartupView {
  const name = supervisedAgentDisplayLabel(entry.displayName, entry.id);
  const retryAt = context.retryRequestedAtMs ?? null;
  const progress = entry.launchProgress ?? null;
  // A failure from before the person's retry is history; the retry is starting.
  const staleFailure = progress?.state === "failed" && retryAt != null
    && (time(progress.endedAt) ?? 0) <= retryAt;
  // Until a launch starts after the retry (or the daemon takes too long to start one), the old failure is not news.
  const retryPending = retryAt != null && !((time(progress?.startedAt) ?? 0) > retryAt)
    && nowMs - retryAt < RETRY_PENDING_MAX_MS;
  const manifest = supervisedLaunchProgress(entry);
  const keys: AgentStartupStageKey[] = ["prepare"];
  if (showsSlot(progress, nowMs)) keys.push("slot");
  keys.push("process");
  if (isClaude(entry.provider)) keys.push("bootstrap");
  keys.push("join", "context");

  const facts = stageFacts(entry, progress, nowMs);
  const stages: AgentStartupStage[] = keys.map((key) => ({
    key,
    label: stageLabel(key, entry, context.roomLabel),
    state: facts.get(key)?.done ? "done" : "pending",
    ms: facts.get(key)?.done ? facts.get(key)?.ms ?? null : null,
  }));
  // Evidence of a later stage means the earlier ones are behind it.
  const lastDone = stages.map((stage) => stage.state).lastIndexOf("done");
  for (let index = 0; index < lastDone; index += 1) {
    if (stages[index]!.state !== "done") stages[index] = { ...stages[index]!, state: "done" };
  }
  let currentIndex = stages.findIndex((stage) => stage.state !== "done");
  const allDone = currentIndex < 0;

  let status: AgentStartupStatus = allDone ? "joined" : "running";
  let failure: AgentStartupView["failure"] = null;
  if (entry.desiredState === "stopped" || context.cancelRequested) {
    status = allDone ? "joined" : "cancelled";
  } else if (!allDone && progress?.state === "failed" && progress.failure && !staleFailure) {
    const failedKey = stageForLaunchPhase(progress.failure.phase, entry.provider);
    const index = stages.findIndex((stage) => stage.key === failedKey);
    currentIndex = index >= 0 ? index : currentIndex;
    status = "failed";
    failure = { reason: failureReason(progress.failure.action, entry), action: progress.failure.action };
  } else if (!allDone && manifest.failed && !manifest.recoverableBlocked && !retryPending) {
    status = "failed";
    const action = manifestFailureAction(entry);
    failure = { reason: action === "retry" ? safeManifestDetail(manifest.failureDetail) : failureReason(action, entry), action };
  }
  if (!allDone) {
    for (let index = currentIndex + 1; index < stages.length; index += 1) {
      stages[index] = { ...stages[index]!, state: "pending", ms: null };
    }
    if (status === "running") stages[currentIndex] = { ...stages[currentIndex]!, state: "now" };
    if (status === "failed") stages[currentIndex] = { ...stages[currentIndex]!, state: "failed" };
  }

  const createdMs = time(entry.createdAt) ?? nowMs;
  // A retry, by the person or by the daemon after a failure, is timed on its own.
  const autoRetryMs = progress && progress.attempt > 1 ? time(progress.startedAt) : null;
  const timerStartMs = Math.max(createdMs, retryAt ?? createdMs, autoRetryMs ?? createdMs);
  const joinedAtMs = allDone ? endOfStartup(entry, entry.launchProgress ?? null) : null;
  const failedAtMs = status === "failed" ? time(entry.launchProgress?.endedAt) ?? nowMs : null;
  const timerEndMs = joinedAtMs ?? failedAtMs ?? (status === "cancelled" ? nowMs : null);

  let line: string;
  if (status === "joined") {
    const parts = [`Joined in ${seconds((joinedAtMs ?? nowMs) - timerStartMs)}`];
    if (entry.model?.trim()) parts.push(entry.model.trim());
    if (context.effort?.trim()) parts.push(context.effort.trim());
    const access = accessLabel(entry);
    if (access) parts.push(access);
    line = parts.join(" · ");
  } else if (status === "failed") {
    line = `Could not start: ${failure!.reason}`;
  } else if (status === "cancelled") {
    line = "Cancelled. Your first message is still in the room.";
  } else {
    const stage = stages[currentIndex]!;
    const note = stage.key === "slot" ? slotNote(entry.launchProgress?.slotAhead ?? null) : null;
    line = note ? `${stage.label} · ${note}…` : `${stage.label}…`;
  }

  const done = stages.filter((stage) => stage.state === "done").length;
  return {
    entryId: entry.id,
    name,
    initials: avatarInitials(name),
    providerLabel: agentRuntimeLabel(entry.provider),
    status,
    stages,
    line,
    fraction: stages.length ? done / stages.length : 0,
    timerStartMs,
    timerEndMs,
    failure,
  };
}

/** The first output after joining, or the moment it joined when it had nothing to say. */
function endOfStartup(entry: Entry, progress: DesktopSupervisorLaunchProgress | null): number | null {
  const candidates = [time(entry.readyReachedAt), time(progress?.endedAt), time(progress?.firstOutputAt)]
    .filter((value): value is number => value != null);
  return candidates.length ? Math.max(...candidates) : null;
}

export function formatStartupElapsed(ms: number): string {
  return seconds(ms);
}

/* ---------- Which rows a room shows: a small pure reducer ---------- */

/** Rows for agents started more than this long ago and never ready are history, not a start-up. */
const STARTUP_ROW_MAX_AGE_MS = 6 * 60 * 60_000;

export interface AgentStartupRowState {
  entryId: string;
  /** The person's first message to this agent; the row sits under it. */
  anchorMessageId: string | null;
  effort: string | null;
  retryRequestedAtMs: number | null;
  cancelRequested: boolean;
}

export interface AgentStartupState {
  rows: AgentStartupRowState[];
  /** Anchors noted before the agent's entry was seen. */
  pendingAnchors: Record<string, { messageId: string; effort: string | null }>;
}

export type AgentStartupEvent =
  | { type: "entries"; entries: readonly Pick<Entry, "id" | "desiredState" | "readyReachedAt" | "createdAt" | "launchProgress">[]; nowMs: number }
  | { type: "anchor"; entryId: string; messageId: string; effort?: string | null }
  /** `nowMs` null: the retry request itself failed. */
  | { type: "retry"; entryId: string; nowMs: number | null }
  | { type: "cancel"; entryId: string }
  | { type: "cancel_failed"; entryId: string };

export function initialAgentStartupState(): AgentStartupState {
  return { rows: [], pendingAnchors: {} };
}

function startsRow(entry: Pick<Entry, "desiredState" | "readyReachedAt" | "createdAt" | "launchProgress">, nowMs: number): boolean {
  if (entry.desiredState !== "running" || entry.readyReachedAt != null) return false;
  if (entry.launchProgress?.state === "running") return true;
  const created = time(entry.createdAt);
  return created != null && nowMs - created < STARTUP_ROW_MAX_AGE_MS;
}

/**
 * A row starts when a never-ready agent appears, and stays (as "Joined…",
 * failed or cancelled) while its entry exists. A later restart of a ready
 * agent never starts a row.
 */
export function reduceAgentStartups(state: AgentStartupState, event: AgentStartupEvent): AgentStartupState {
  switch (event.type) {
    case "entries": {
      const present = new Map(event.entries.map((entry) => [entry.id, entry]));
      const rows = state.rows.filter((row) => present.has(row.entryId));
      const pendingAnchors = { ...state.pendingAnchors };
      for (const entry of event.entries) {
        if (rows.some((row) => row.entryId === entry.id) || !startsRow(entry, event.nowMs)) continue;
        const anchor = pendingAnchors[entry.id];
        delete pendingAnchors[entry.id];
        rows.push({ entryId: entry.id, anchorMessageId: anchor?.messageId ?? null, effort: anchor?.effort ?? null, retryRequestedAtMs: null, cancelRequested: false });
      }
      const unchanged = rows.length === state.rows.length && rows.every((row, index) => row === state.rows[index])
        && Object.keys(pendingAnchors).length === Object.keys(state.pendingAnchors).length;
      return unchanged ? state : { rows, pendingAnchors };
    }
    case "anchor": {
      const effort = event.effort ?? null;
      if (!state.rows.some((row) => row.entryId === event.entryId)) {
        return { ...state, pendingAnchors: { ...state.pendingAnchors, [event.entryId]: { messageId: event.messageId, effort } } };
      }
      return { ...state, rows: state.rows.map((row) => row.entryId === event.entryId
        ? { ...row, anchorMessageId: event.messageId, effort: effort ?? row.effort } : row) };
    }
    case "retry":
      return { ...state, rows: state.rows.map((row) => row.entryId === event.entryId
        ? { ...row, retryRequestedAtMs: event.nowMs, cancelRequested: false } : row) };
    case "cancel":
      return { ...state, rows: state.rows.map((row) => row.entryId === event.entryId ? { ...row, cancelRequested: true } : row) };
    case "cancel_failed":
      return { ...state, rows: state.rows.map((row) => row.entryId === event.entryId ? { ...row, cancelRequested: false } : row) };
  }
}

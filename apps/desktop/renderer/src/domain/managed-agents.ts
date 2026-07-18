import type {
  DesktopAgentPresence,
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderSetupAction,
  DesktopCursorMcpPolicy,
  DesktopGitRoomInfo,
  DesktopManagedAgentPermissionProfile,
  DesktopManagedAgentPermissionProfileId,
  DesktopManagedAgentPermissionRequest,
  DesktopManagedAgentSession,
  DesktopParticipantSummary,
  DesktopReasoningSession,
  DesktopRoomInfo,
  DesktopSupervisorManifestEntry,
  RepoStatus,
  RepoWorktreeEntry,
} from "../../../electron/ipc-types";
import { safeUserVisibleErrorDetail } from "./user-visible-error";
import { normalizeAgentKey } from "./agents";

export interface AgentSetupConfirmation {
  providerId: DesktopAgentProviderId;
  action: DesktopAgentProviderSetupAction;
}

export function hasDesktopManagedRuntime(
  provider: Pick<DesktopAgentProvider, "capabilities"> | null | undefined,
): boolean {
  return Boolean(provider?.capabilities.includes("desktop_managed_runtime"));
}

/**
 * Durable supervision is stricter than the app-owned managed runtime. A
 * provider opts in only after its native evidence cells prove that lifecycle.
 */
export function hasSupervisedRuntime(
  provider: Pick<DesktopAgentProvider, "capabilities"> | null | undefined,
): boolean {
  return Boolean(provider?.capabilities.includes("supervised_runtime"));
}

export function visibleDesktopAgentProviders(
  providers: DesktopAgentProvider[],
): DesktopAgentProvider[] {
  return providers.filter((provider) => provider.id !== "antigravity");
}

export function preferredManagedAgentRepoRootPath(
  repoStatus: Pick<RepoStatus, "rootPath" | "mainRootPath" | "worktrees" | "defaultBranch"> | null | undefined,
  gitRoom?: Pick<DesktopGitRoomInfo, "ref" | "isDefault"> | null,
): string | null {
  const matchingWorktree = matchingManagedAgentWorktrees(repoStatus, gitRoom)[0];
  if (matchingWorktree?.path.trim()) {
    return matchingWorktree.path.trim();
  }
  const mainRootPath = String(repoStatus?.mainRootPath ?? "").trim();
  if (mainRootPath) {
    return mainRootPath;
  }
  const rootPath = String(repoStatus?.rootPath ?? "").trim();
  return rootPath || null;
}

/**
 * Resolve the local cwd from room ownership, not from the transient repo-status
 * probe. A verified live status still wins so branch rooms select their exact
 * worktree. When that probe is absent or stale, the durable root recorded when
 * the project room was opened keeps focus rooms attached to the same project.
 * A repo-backed room (has a gitRoom or a durable project root) whose root cannot
 * be resolved returns null so the caller requires an explicit repo selection —
 * it must never fall back to HOME, which is not a repo and would make the daemon
 * convergence block. Only rooms with no project context use the OS home
 * directory deterministically.
 */
export function managedAgentRootPathForRoom(input: {
  room: Pick<DesktopRoomInfo, "gitRoom">;
  repoStatus: Pick<RepoStatus, "rootPath" | "mainRootPath" | "worktrees" | "defaultBranch"> | null | undefined;
  gitRoomMatchesActiveRepo: boolean;
  durableProjectRootPath?: string | null;
  homePath?: string | null;
}): string | null {
  const durableProjectRoot = input.durableProjectRootPath?.trim() || null;
  const hasProjectContext = Boolean(input.room.gitRoom || durableProjectRoot);
  const statusRoot = input.repoStatus?.rootPath?.trim() || null;
  const statusMainRoot = input.repoStatus?.mainRootPath?.trim() || null;
  const statusMatchesProject = input.room.gitRoom
    ? input.gitRoomMatchesActiveRepo
    : Boolean(durableProjectRoot && (statusRoot === durableProjectRoot || statusMainRoot === durableProjectRoot));
  const verifiedRepoStatus = hasProjectContext && statusMatchesProject ? input.repoStatus : null;
  const verifiedRoot = preferredManagedAgentRepoRootPath(verifiedRepoStatus, input.room.gitRoom);
  if (verifiedRoot) return verifiedRoot;

  if (durableProjectRoot) return durableProjectRoot;

  // A repo-backed room whose root could not be resolved must require an explicit
  // repo selection rather than silently launching against HOME.
  if (hasProjectContext) return null;

  return input.homePath?.trim() || null;
}

export function branchScopedGitRoomExpectedBranch(
  gitRoom: Pick<DesktopGitRoomInfo, "ref" | "isDefault"> | null | undefined,
  repoStatus?: Pick<RepoStatus, "defaultBranch"> | null,
): string | null {
  if (!gitRoom) return null;
  const expectedBranch = gitRoom.ref.type === "branch"
    ? gitRoom.ref.name?.trim() || null
    : null;
  if (!expectedBranch) return null;
  if (gitRoom.isDefault) return null;
  const defaultBranch = gitRoom.ref.defaultBranch?.trim() || repoStatus?.defaultBranch?.trim() || null;
  if (defaultBranch && expectedBranch === defaultBranch) return null;
  return expectedBranch;
}

export function matchingManagedAgentWorktrees(
  repoStatus: Pick<RepoStatus, "worktrees" | "defaultBranch"> | null | undefined,
  gitRoom?: Pick<DesktopGitRoomInfo, "ref" | "isDefault"> | null,
): RepoWorktreeEntry[] {
  const expectedBranch = branchScopedGitRoomExpectedBranch(gitRoom, repoStatus);
  return matchingManagedAgentWorktreesForBranch(repoStatus, expectedBranch);
}

export function matchingManagedAgentWorktreesForBranch(
  repoStatus: Pick<RepoStatus, "worktrees"> | null | undefined,
  expectedBranch: string | null | undefined,
): RepoWorktreeEntry[] {
  const branch = expectedBranch?.trim() || null;
  if (!branch) return [];
  return (repoStatus?.worktrees || [])
    .filter((worktree) => worktree.branch?.trim() === branch)
    .sort((left, right) => Number(right.isCurrent) - Number(left.isCurrent));
}

export function isBranchScopedGitRoomIdentifier(roomIdentifier: string | null | undefined): boolean {
  return /^git-room:(?:github\.com:[^:\s]+|local:[^:\s]+):branch:[A-Za-z0-9_-]+$/i.test(
    roomIdentifier?.trim() || "",
  );
}

export function managedAgentRepoStatusForRoom<T extends Pick<RepoStatus, "rootPath">>(
  repoStatus: T,
  room: Pick<DesktopRoomInfo, "identifier" | "gitRoom">,
  gitRoomMatchesActiveRepo: boolean,
): T | null {
  if (room.gitRoom) {
    return gitRoomMatchesActiveRepo ? repoStatus : null;
  }
  if (isBranchScopedGitRoomIdentifier(room.identifier)) {
    return null;
  }
  return repoStatus;
}

/** Native Claude CLI policy corresponding to an available desktop profile. */
export function supervisedProviderLaunchPolicy(
  providerId: DesktopAgentProviderId | null | undefined,
  permissionProfileId: DesktopManagedAgentPermissionProfileId | null | undefined,
): Record<string, unknown> | undefined {
  if (providerId !== "claude-code") return undefined;
  switch (permissionProfileId) {
    case "read_only": return { permissionMode: "plan" };
    case "ask_before_write": return { permissionMode: "default" };
    case "full_access": return { permissionMode: "bypassPermissions" };
    default: throw new Error("Choose an available Claude Code permission profile before supervised launch.");
  }
}

export function isVisibleManagedAgentSession(
  session: DesktopManagedAgentSession,
): boolean {
  if (session.status === "failed" || session.status === "interrupted") {
    return false;
  }
  return session.canStop;
}

export function isDeliverableManagedAgentSession(
  session: DesktopManagedAgentSession,
): boolean {
  return isVisibleManagedAgentSession(session) &&
    session.status !== "blocked" &&
    Boolean(session.agentSessionId) &&
    (
      session.status === "running" ||
      session.status === "unknown" ||
      (session.deliveryMode === "desktop_events" && session.status === "completed")
    );
}

export function canStopManagedAgentTurn(
  session: Pick<DesktopManagedAgentSession, "canStop" | "status"> | null | undefined,
): boolean {
  return Boolean(
    session?.canStop &&
    (session.status === "starting" || session.status === "running")
  );
}

export function normalizeManagedAgentRoomIdentifier(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

/**
 * Resolve Inspector activity through durable supervisor bindings when they
 * exist. Returning null (rather than an empty list) tells the caller that a
 * pre-registration label fallback is still necessary.
 */
export function exactSupervisorEntriesForManagedSessions(
  entries: readonly DesktopSupervisorManifestEntry[],
  sessions: readonly Pick<DesktopManagedAgentSession, "supervisorEntryId">[],
): DesktopSupervisorManifestEntry[] | null {
  const ids = new Set(sessions.map((session) => session.supervisorEntryId).filter((id): id is string => Boolean(id)));
  if (ids.size === 0) return null;
  return entries.filter((entry) => ids.has(entry.id));
}

/**
 * Prefer the daemon's durable worker binding over every display-name fallback.
 * A room worker may be renamed when it re-registers, while same-provider peers
 * may intentionally share one manifest label.
 */
export function exactSupervisorEntriesForTarget(
  entries: readonly DesktopSupervisorManifestEntry[],
  sessions: readonly Pick<DesktopManagedAgentSession, "supervisorEntryId">[],
  targetAgentSessionId: string | null | undefined,
  knownSupervisorEntryIds: readonly string[] = [],
): DesktopSupervisorManifestEntry[] | null {
  const sessionId = targetAgentSessionId?.trim() || null;
  if (sessionId) {
    const bound = entries.filter((entry) => entry.agentSessionId === sessionId);
    if (bound.length) return bound;
  }
  const sessionEntries = exactSupervisorEntriesForManagedSessions(entries, sessions);
  if (sessionEntries) return sessionEntries;
  const knownIds = new Set(knownSupervisorEntryIds);
  if (knownIds.size) {
    return entries.filter((entry) => knownIds.has(entry.id));
  }
  // A specific room worker must never widen to a same-label peer merely
  // because its daemon projection is still loading.
  return sessionId ? [] : null;
}

/**
 * Join an Activity worker back to the local managed session that launched its
 * supervisor entry. The managed runtime's own agentSessionId can differ from
 * the room worker id after MCP registration, so supervisorEntryId is the
 * durable bridge between those two projections.
 */
export function managedAgentSessionMatchesSupervisorTarget(
  session: Pick<DesktopManagedAgentSession, "supervisorEntryId">,
  entries: readonly DesktopSupervisorManifestEntry[],
  targetAgentSessionId: string | null | undefined,
  knownSupervisorEntryIds: readonly string[] = [],
): boolean {
  const exactEntries = exactSupervisorEntriesForTarget(
    entries,
    [],
    targetAgentSessionId,
    knownSupervisorEntryIds,
  );
  if (!exactEntries || exactEntries.length !== 1) return false;
  return Boolean(
    session.supervisorEntryId &&
    session.supervisorEntryId === exactEntries[0]!.id
  );
}

export interface ManagedAgentProviderIdentity {
  supervisorEntryId: string;
  providerId: string;
  label: string;
  model: string | null;
  accessibleLabel: string;
  bindingState: DesktopSupervisorManifestEntry["agentSessionBindingState"];
}

/**
 * Resolve provider presentation only after an exact daemon/session binding is
 * available. The Inspector must not infer a provider from a display name: two
 * supervised peers can intentionally share that name while using different
 * providers or generations.
 */
export function managedAgentProviderIdentityForTarget(
  entries: readonly DesktopSupervisorManifestEntry[],
  sessions: readonly Pick<DesktopManagedAgentSession, "supervisorEntryId">[],
  targetAgentSessionId: string | null | undefined,
  knownSupervisorEntryIds: readonly string[] = [],
): ManagedAgentProviderIdentity | null {
  const exactEntries = exactSupervisorEntriesForTarget(
    entries,
    sessions,
    targetAgentSessionId,
    knownSupervisorEntryIds,
  );
  if (!exactEntries || exactEntries.length !== 1) return null;

  const entry = exactEntries[0]!;
  const providerId = entry.provider.trim();
  if (!providerId) return null;
  const label = managedAgentProviderLabel(providerId);
  const model = entry.model?.trim() || null;
  return {
    supervisorEntryId: entry.id,
    providerId,
    label,
    model,
    accessibleLabel: model ? `${label} · ${model}` : label,
    bindingState: entry.agentSessionBindingState,
  };
}

export function managedAgentProviderLabel(providerId: string): string {
  switch (providerId.trim().toLowerCase()) {
    case "codex": return "Codex";
    case "claude":
    case "claude-code": return "Claude Code";
    case "antigravity": return "Antigravity";
    case "cursor": return "Cursor";
    case "open-model":
    case "open_model": return "Open Model";
    default: return providerId.trim();
  }
}

/**
 * Project bounded native activity into the existing chat work indicator. This
 * is observable lifecycle evidence, never hidden reasoning text.
 */
export function supervisedAgentWorkIndicators(
  entries: readonly DesktopSupervisorManifestEntry[],
  presence: readonly Pick<DesktopAgentPresence, "agentSessionId" | "displayName" | "actorLabel">[],
  roomIdentifier: string | null | undefined,
): ManagedAgentWorkIndicator[] {
  const room = normalizeManagedAgentRoomIdentifier(roomIdentifier);
  return entries
    .filter((entry) =>
      normalizeManagedAgentRoomIdentifier(entry.roomId) === room &&
      entry.agentSessionBindingState === "active" &&
      entry.desiredState === "running" &&
      entry.observedState === "working" &&
      entry.condition === "none" &&
      entry.nativeLiveness.state === "active"
    )
    .flatMap((entry) => {
      const latest = [...entry.activity]
        .sort((left, right) => right.sequence - left.sequence)
        .find((event) => event.status === "working" || event.status === "reviewing");
      if (!latest) return [];
      const boundPresence = entry.agentSessionId
        ? presence.find((candidate) => candidate.agentSessionId === entry.agentSessionId)
        : null;
      return [{
        // Stable per-entry id so the indicator updates its echo in place as the
        // native stream progresses instead of remounting (and re-animating) on
        // every new activity event.
        id: entry.id,
        displayName: boundPresence?.displayName || boundPresence?.actorLabel || entry.displayName,
        summary: liveActivityEchoText(latest.summary),
        startedAt: latest.observedAt,
      }];
    })
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

/**
 * Managed session lists are re-fetched on 4s polls from both the room shell
 * and the Add Agent modal. Assigning a freshly-allocated but content-equal
 * array into reactive state re-renders every dependent surface each tick,
 * which reads as constant flicker. These helpers keep the CURRENT reference
 * whenever the content did not change so idle polls trigger no reactivity.
 */
export function managedAgentSessionListsEqual(
  a: DesktopManagedAgentSession[],
  b: DesktopManagedAgentSession[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index] && JSON.stringify(a[index]) !== JSON.stringify(b[index])) {
      return false;
    }
  }
  return true;
}

export function withRoomManagedAgentSessions(
  current: DesktopManagedAgentSession[],
  roomIdentifier: string,
  incoming: DesktopManagedAgentSession[],
): DesktopManagedAgentSession[] {
  const next = [
    ...current.filter((session) => !managedAgentSessionMatchesRoom(session, roomIdentifier)),
    ...incoming,
  ];
  return managedAgentSessionListsEqual(current, next) ? current : next;
}

export function withUpsertedManagedAgentSession(
  current: DesktopManagedAgentSession[],
  session: DesktopManagedAgentSession,
): DesktopManagedAgentSession[] {
  const existing = current.find((entry) => entry.id === session.id);
  if (existing && (existing === session || JSON.stringify(existing) === JSON.stringify(session))) {
    return current;
  }
  return [session, ...current.filter((entry) => entry.id !== session.id)];
}

export function managedAgentSessionMatchesRoom(
  session: Pick<DesktopManagedAgentSession, "roomIdentifier">,
  roomIdentifier: string | null | undefined,
): boolean {
  const sessionRoom = normalizeManagedAgentRoomIdentifier(session.roomIdentifier);
  const targetRoom = normalizeManagedAgentRoomIdentifier(roomIdentifier);
  return Boolean(sessionRoom && targetRoom && sessionRoom === targetRoom);
}

export function managedAgentPermissionRequestTargetLabel(
  request: Pick<DesktopManagedAgentPermissionRequest, "inputSummary" | "description">,
  session: Pick<DesktopManagedAgentSession, "repoRootPath">,
): string | null {
  const target = String(request.inputSummary || request.description || "").trim();
  if (!target) {
    return null;
  }
  const repoRoot = String(session.repoRootPath || "").trim();
  if (repoRoot && target === repoRoot) {
    return ".";
  }
  if (repoRoot && target.startsWith(`${repoRoot}/`)) {
    return target.slice(repoRoot.length + 1);
  }
  return target;
}

export function pendingManagedAgentPermissionApprovals(
  sessions: readonly DesktopManagedAgentSession[],
  roomIdentifier: string | null | undefined,
): ManagedAgentPermissionApproval[] {
  return sessions
    .filter((session) => managedAgentSessionMatchesRoom(session, roomIdentifier))
    .flatMap((session) => (session.pendingPermissionRequests ?? []).map((request) => ({
      id: request.id,
      session,
      request,
      displayName: managedAgentSessionDisplayName(session),
      providerLabel: session.ideLabel || String(request.providerId || "Agent"),
      title: request.title?.trim() || `Use ${request.toolName || "tool"}`,
      toolName: request.toolName?.trim() || "Tool",
      targetLabel: managedAgentPermissionRequestTargetLabel(request, session),
      requestedAt: request.requestedAt || session.updatedAt,
    })))
    .sort((left, right) =>
      left.requestedAt.localeCompare(right.requestedAt) ||
      left.displayName.localeCompare(right.displayName) ||
      left.id.localeCompare(right.id)
    );
}

export interface ManagedAgentTargetKeys {
  agentSessionId?: string | null;
  agentKey?: string | null;
  actorLabel?: string | null;
  displayName?: string | null;
  ideLabel?: string | null;
  ownerAttribution?: string | null;
  sender?: string | null;
}

export interface ManagedAgentWorkIndicator {
  id: string;
  displayName: string;
  summary: string;
  startedAt: string;
}

/** Longest live-activity echo shown in the room work indicator. */
export const LIVE_ACTIVITY_ECHO_MAX_LENGTH = 100;

/** Default number of concurrent work indicators shown before collapsing. */
export const WORK_INDICATOR_VISIBLE_LIMIT = 3;

/**
 * Last-mile guard for the live-activity echo. The daemon already sanitizes and
 * redacts native activity, but the echo is human-facing in a shared room, so
 * collapse whitespace/control characters to a single line and length-bound it
 * to keep the indicator unobtrusive and prevent any multi-line payload from
 * widening the row.
 */
export function liveActivityEchoText(summary: string | null | undefined): string {
  const collapsed = (summary ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return "Working in the room.";
  if (collapsed.length <= LIVE_ACTIVITY_ECHO_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, LIVE_ACTIVITY_ECHO_MAX_LENGTH - 1).trimEnd()}…`;
}

export interface CollapsedWorkIndicators {
  visible: ManagedAgentWorkIndicator[];
  hiddenCount: number;
}

/**
 * Keep the work-indicator area unobtrusive when many agents are active at once
 * (EmmyMay's ten-agent noise constraint): show the most recent `maxVisible` and
 * report the rest as an overflow count instead of an unbounded list.
 */
export function collapseWorkIndicators(
  indicators: readonly ManagedAgentWorkIndicator[],
  maxVisible: number = WORK_INDICATOR_VISIBLE_LIMIT,
): CollapsedWorkIndicators {
  if (maxVisible <= 0 || indicators.length <= maxVisible) {
    return { visible: [...indicators], hiddenCount: 0 };
  }
  // Show the MOST RECENT maxVisible (newest first). The upstream list may be
  // sorted oldest-first, so select by startedAt descending rather than taking
  // the head, which would surface the stalest agents.
  const byRecency = [...indicators].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  return {
    visible: byRecency.slice(0, maxVisible),
    hiddenCount: indicators.length - maxVisible,
  };
}

/** Minimum time an entry's echo text is held before it may change again. */
export const WORK_INDICATOR_ECHO_MIN_INTERVAL_MS = 2500;

export interface WorkIndicatorEchoEntryState {
  /** The summary currently shown for this entry. */
  summary: string;
  /** When that shown summary last changed (ms epoch). */
  shownAtMs: number;
  /** A newer summary held back inside the throttle window, if any. */
  pending: string | null;
}

export type WorkIndicatorEchoState = Record<string, WorkIndicatorEchoEntryState>;

export interface CoalescedWorkIndicatorEchoes {
  state: WorkIndicatorEchoState;
  indicators: ManagedAgentWorkIndicator[];
  /** True when at least one newer echo is held back awaiting the next window. */
  hasPending: boolean;
}

/**
 * Rate-limit live echo text per entry: an entry's shown summary changes at
 * most once per `minIntervalMs`. Newer summaries arriving inside the window are
 * held as `pending` (latest value wins) and surface on the next call once the
 * window has elapsed. Entries absent from `incoming` are dropped from state
 * (idle clear / cancellation). Pure and deterministic — `nowMs` is injected.
 */
export function coalesceWorkIndicatorEchoes(
  previous: WorkIndicatorEchoState,
  incoming: readonly ManagedAgentWorkIndicator[],
  nowMs: number,
  minIntervalMs: number = WORK_INDICATOR_ECHO_MIN_INTERVAL_MS,
): CoalescedWorkIndicatorEchoes {
  const state: WorkIndicatorEchoState = {};
  let hasPending = false;
  const indicators = incoming.map((indicator) => {
    const prior = previous[indicator.id];
    if (!prior) {
      state[indicator.id] = { summary: indicator.summary, shownAtMs: nowMs, pending: null };
      return indicator;
    }
    if (indicator.summary === prior.summary) {
      state[indicator.id] = { summary: prior.summary, shownAtMs: prior.shownAtMs, pending: null };
      return { ...indicator, summary: prior.summary };
    }
    if (nowMs - prior.shownAtMs >= minIntervalMs) {
      state[indicator.id] = { summary: indicator.summary, shownAtMs: nowMs, pending: null };
      return indicator;
    }
    // Inside the throttle window: keep showing the prior summary, hold the
    // newest incoming as pending so the latest value wins once it elapses.
    state[indicator.id] = { summary: prior.summary, shownAtMs: prior.shownAtMs, pending: indicator.summary };
    hasPending = true;
    return { ...indicator, summary: prior.summary };
  });
  return { state, indicators, hasPending };
}

export interface ManagedAgentPermissionApproval {
  id: string;
  session: DesktopManagedAgentSession;
  request: DesktopManagedAgentPermissionRequest;
  displayName: string;
  providerLabel: string;
  title: string;
  toolName: string;
  targetLabel: string | null;
  requestedAt: string;
}

function specificAgentKey(value: string | null | undefined): string {
  const normalized = normalizeAgentKey(value);
  if (!normalized || !/[/:]/.test(normalized)) {
    return "";
  }
  return normalized;
}

export function managedAgentSessionMatchesTarget(
  session: Pick<DesktopManagedAgentSession, "agentSessionId" | "agentKey" | "actorLabel" | "displayName" | "ideLabel" | "ownerLabel">,
  target: ManagedAgentTargetKeys,
): boolean {
  const sessionKeys = [
    normalizeAgentKey(session.agentSessionId),
    specificAgentKey(session.agentKey),
    normalizeAgentKey(session.actorLabel),
  ].filter(Boolean);
  const targetKeys = [
    normalizeAgentKey(target.agentSessionId),
    specificAgentKey(target.agentKey),
    normalizeAgentKey(target.actorLabel),
  ].filter(Boolean);
  if (sessionKeys.some((key) => targetKeys.includes(key))) {
    return true;
  }

  const sessionDisplayName = normalizeAgentKey(session.displayName);
  const targetDisplayName = normalizeAgentKey(target.displayName);
  if (!sessionDisplayName || !targetDisplayName || sessionDisplayName !== targetDisplayName) {
    return false;
  }

  const sessionIdeLabel = normalizeAgentKey(session.ideLabel);
  const targetIdeLabel = normalizeAgentKey(target.ideLabel);
  if (sessionIdeLabel || targetIdeLabel) {
    return Boolean(sessionIdeLabel && targetIdeLabel && sessionIdeLabel === targetIdeLabel);
  }

  const sessionOwnerLabel = normalizeAgentKey(session.ownerLabel);
  const targetOwnerAttribution = normalizeAgentKey(target.ownerAttribution);
  return Boolean(
    sessionOwnerLabel &&
    targetOwnerAttribution &&
    targetOwnerAttribution.includes(sessionOwnerLabel),
  );
}

export function managedAgentSessionMatchesReasoning(
  session: Pick<DesktopManagedAgentSession, "agentSessionId" | "reasoningSessionId">,
  reasoning: Pick<DesktopReasoningSession, "id" | "agentSessionId"> | null | undefined,
): boolean {
  if (!reasoning) return false;
  if (session.reasoningSessionId && session.reasoningSessionId === reasoning.id) return true;
  return Boolean(session.agentSessionId && reasoning.agentSessionId && session.agentSessionId === reasoning.agentSessionId);
}

export interface ManagedAgentDetailSelection {
  managedSessions: DesktopManagedAgentSession[];
  supervisorEntries: DesktopSupervisorManifestEntry[];
  providerIdentity: ManagedAgentProviderIdentity | null;
  showExternalFallback: boolean;
}

/**
 * Behavioral projection used by the Agent Inspector. Keeping the complete
 * selection in one domain function makes exact binding, provider identity,
 * local-session state, and the external fallback impossible to drift apart.
 */
export function managedAgentDetailSelection(
  sessions: readonly DesktopManagedAgentSession[],
  entries: readonly DesktopSupervisorManifestEntry[],
  target: ManagedAgentTargetKeys | null | undefined,
  reasoning: Pick<DesktopReasoningSession, "id" | "agentSessionId"> | null | undefined,
  knownSupervisorEntryIds: readonly string[] = [],
): ManagedAgentDetailSelection {
  if (!target) {
    return {
      managedSessions: [],
      supervisorEntries: [],
      providerIdentity: null,
      showExternalFallback: true,
    };
  }

  const eligibleSessions = sessions.filter((session) =>
    isVisibleManagedAgentSession(session) || Boolean(session.supervisorEntryId)
  );
  const managedSessions = eligibleSessions.filter((session) =>
    managedAgentSessionMatchesTarget(session, target) ||
    managedAgentSessionMatchesReasoning(session, reasoning) ||
    managedAgentSessionMatchesSupervisorTarget(
      session,
      entries,
      target.agentSessionId,
      knownSupervisorEntryIds,
    )
  );

  const exactEntries = exactSupervisorEntriesForTarget(
    entries,
    managedSessions,
    target.agentSessionId,
    knownSupervisorEntryIds,
  );
  const supervisorEntries = exactEntries
    ? exactEntries.length === 1 ? exactEntries : []
    : (() => {
    const labels = new Set([
      target.displayName,
      target.sender,
      target.actorLabel,
      target.ideLabel,
    ].filter(Boolean).map((value) => String(value).toLowerCase()));
    return entries.filter((entry) => {
      const displayName = entry.displayName.toLowerCase();
      return labels.has(displayName) ||
        [...labels].some((label) => label.startsWith(`${displayName} |`));
    });
    })();
  const providerIdentity = managedAgentProviderIdentityForTarget(
    entries,
    managedSessions,
    target.agentSessionId,
    knownSupervisorEntryIds,
  );

  return {
    managedSessions,
    supervisorEntries,
    providerIdentity,
    showExternalFallback: managedSessions.length === 0 && supervisorEntries.length === 0,
  };
}

export function isExternalMcpProviderReady(
  provider: Pick<DesktopAgentProvider, "capabilities"> | null | undefined,
  preflight: Pick<DesktopAgentProviderPreflight, "status" | "mcpStatus"> | null | undefined,
): boolean {
  return Boolean(
    provider &&
    !hasDesktopManagedRuntime(provider) &&
    preflight?.status === "ready" &&
    preflight.mcpStatus === "installed",
  );
}

export function agentProviderNeedsDesktopRepo(
  provider: Pick<DesktopAgentProvider, "capabilities"> | null | undefined,
): boolean {
  return hasDesktopManagedRuntime(provider);
}

export const defaultCursorMcpPolicy: DesktopCursorMcpPolicy = "filter_letagents";

export const cursorMcpPolicyOptions: Array<{
  id: DesktopCursorMcpPolicy;
  label: string;
  description: string;
}> = [
  {
    id: "filter_letagents",
    label: "Filter LetAgents",
    description: "Use my MCPs except LetAgents.",
  },
  {
    id: "normal",
    label: "Normal Cursor MCPs",
    description: "Use my normal Cursor MCP setup as-is.",
  },
  {
    id: "none",
    label: "No MCPs",
    description: "Start Cursor with MCP tools disabled.",
  },
];

export function cursorMcpPolicyDescription(
  policy: DesktopCursorMcpPolicy | null | undefined,
): string {
  return cursorMcpPolicyOptions.find((option) => option.id === policy)?.description ??
    cursorMcpPolicyOptions[0]?.description ??
    "Use my MCPs except LetAgents.";
}

export function cursorMcpPolicyLabel(
  policy: DesktopCursorMcpPolicy | null | undefined,
): string {
  return cursorMcpPolicyOptions.find((option) => option.id === policy)?.label ??
    cursorMcpPolicyOptions[0]?.label ??
    "Filter LetAgents";
}

export function shouldShowCursorMcpPolicySelector(
  provider: Pick<DesktopAgentProvider, "id" | "capabilities"> | null | undefined,
): boolean {
  return provider?.id === "cursor" && hasDesktopManagedRuntime(provider);
}

export function shouldShowOpenModelConfig(
  provider: Pick<DesktopAgentProvider, "id" | "capabilities"> | null | undefined,
): boolean {
  return provider?.id === "open-model" && hasDesktopManagedRuntime(provider);
}

export function shouldShowManagedModelSelector(
  provider: Pick<DesktopAgentProvider, "id" | "capabilities"> | null | undefined,
): boolean {
  return Boolean(provider && hasDesktopManagedRuntime(provider));
}

export function shouldShowDeliveryModeSelector(
  provider: Pick<DesktopAgentProvider, "id" | "capabilities"> | null | undefined,
): boolean {
  // Providers without an external MCP join path (e.g. open-model) always
  // deliver room events from the desktop app, so there is nothing to choose.
  // Claude Code and Cursor have external MCP setup, but their supervised
  // desktop runtimes only support desktop-delivered room events.
  return provider?.id === "codex" &&
    hasDesktopManagedRuntime(provider) &&
    Boolean(provider?.capabilities.includes("external_mcp"));
}

export function agentAuthCommand(
  provider: Pick<DesktopAgentProvider, "id" | "runtimeCommand"> | null | undefined,
): string | null {
  if (provider?.id === "claude-code") {
    return `${provider.runtimeCommand?.trim() || "claude"} auth login`;
  }
  if (provider?.id !== "codex") return null;
  return `${provider.runtimeCommand?.trim() || "codex"} login --device-auth`;
}

export function externalMcpProviderInstruction(
  provider: Pick<DesktopAgentProvider, "name"> | null | undefined,
): string {
  const name = provider?.name?.trim() || "this provider";
  return `Open ${name}, then ask it to join this room through the installed LetAgents connection.`;
}

function looksLikeLetAgentsInviteCode(value: string): boolean {
  return /^[a-z0-9]{4}(?:-[a-z0-9]{4})+$/i.test(value.trim());
}

function roomIdentifierForJoinPayload(value: string | null | undefined): string {
  const trimmed = String(value || "").trim();
  return looksLikeLetAgentsInviteCode(trimmed) ? trimmed.toUpperCase() : trimmed;
}

function toolCallPayload(payload: Record<string, string | number>): string {
  return JSON.stringify(payload);
}

function optionalRegisterPayload(input: {
  runtime: string;
  repoRootPath?: string | null;
}): Record<string, string> {
  const payload: Record<string, string> = {
    session_kind: "worker",
    runtime: input.runtime,
    display_name: "<your agent name>",
  };
  const cwd = input.repoRootPath?.trim();
  if (cwd) {
    payload.cwd = cwd;
  }
  return payload;
}

const LETAGENTS_CODENAME_EXAMPLES = "MapleRidge, CedarVista, DawnWinter, GardenFern, SilverHarbor";

export function externalMcpProviderJoinPrompt(
  provider: Pick<DesktopAgentProvider, "id" | "name" | "mcpTargetId"> | null | undefined,
  roomIdentifier: string | null | undefined,
  repoRootPath?: string | null,
): string {
  const name = provider?.name?.trim() || "this agent";
  const runtime = provider?.mcpTargetId?.trim() || provider?.id?.trim() || name.toLowerCase().replace(/\s+/g, "-");
  const room = roomIdentifierForJoinPayload(roomIdentifier);
  const joinInstruction = room
    ? looksLikeLetAgentsInviteCode(room)
      ? `Call join_code with ${toolCallPayload({ code: room, session_mode: "current" })}.`
      : `Call join_room with ${toolCallPayload({ name: room, session_mode: "current" })}.`
    : "Call join_room or join_code for this LetAgents room once you know the room target.";
  return [
    "Use the installed LetAgents connection.",
    joinInstruction,
    `Choose a short distinct LetAgents-style agent name before doing any room work. Examples: ${LETAGENTS_CODENAME_EXAMPLES}.`,
    `Call set_agent_name with ${toolCallPayload({ name: "<your agent name>" })} before posting status or registering.`,
    `Call register_agent_session with ${toolCallPayload(optionalRegisterPayload({ runtime, repoRootPath }))}.`,
    "Do not continue into the room loop until register_agent_session succeeds.",
    `Call post_status with ${toolCallPayload({ agent_session_id: "<returned agent_session_id>", status: "available in the room" })}.`,
    "Call read_messages once, then call get_board once.",
    "If get_board shows accepted unassigned work that is appropriate for you, claim it with claim_task using the returned agent_session_id.",
    `Stay connected by calling wait_for_messages with ${toolCallPayload({ agent_session_id: "<returned agent_session_id>", after_message_id: "<latest seen message id>", timeout: 30000 })} in a loop.`,
    "When messages arrive, update after_message_id to the newest processed message id, use send_message or send_thread_message with the same agent_session_id when useful, and keep waiting; an empty wait result just means continue waiting.",
    `Do not call yourself ${name}, ${name} 1, ${name} 2, or use any numbered provider label.`,
  ].join("\n");
}

export function isAgentSetupConfirmationActive(
  confirmation: AgentSetupConfirmation | null | undefined,
  providerId: DesktopAgentProviderId | null | undefined,
  action: DesktopAgentProviderSetupAction | null | undefined,
): boolean {
  return Boolean(
    confirmation &&
    providerId &&
    action &&
    confirmation.providerId === providerId &&
    confirmation.action === action,
  );
}

export function agentSetupActionButtonLabel(
  action: DesktopAgentProviderSetupAction,
  provider: Pick<DesktopAgentProvider, "name"> | null | undefined,
  armed: boolean,
  busy: boolean,
): string {
  if (busy) return "Installing...";
  if (action === "install_runtime") {
    const name = provider?.name?.trim() || "runtime";
    return armed ? `Confirm install ${name}` : `Install ${name}`;
  }
  return armed ? "Confirm connection install" : "Install LetAgents connection";
}

export function agentSetupConfirmationMessage(
  action: DesktopAgentProviderSetupAction,
  provider: Pick<DesktopAgentProvider, "id" | "name"> | null | undefined,
): string {
  const name = provider?.name?.trim() || "this provider";
  if (action === "install_runtime") {
    return provider?.id === "codex"
      ? "LetAgents will install the official Codex CLI runtime on this machine after confirmation."
      : `LetAgents will install the official ${name} runtime on this machine after confirmation.`;
  }
  return `LetAgents will update ${name}'s agent app configuration to add the LetAgents connection after confirmation.`;
}

export function managedAgentSessionStatusLabel(
  session: Pick<DesktopManagedAgentSession, "deliveryMode" | "status">,
): string {
  if (session.deliveryMode === "desktop_events" && session.status === "completed") {
    return "Waiting for events";
  }
  if (session.status === "blocked") return "Needs attention";
  return session.status.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function managedAgentStopResultMessage(
  session: Pick<DesktopManagedAgentSession, "lastError" | "status">,
): string {
  if (session.lastError?.trim()) {
    return safeUserVisibleErrorDetail(session.lastError, "The agent could not be stopped.");
  }
  if (session.status === "unknown") {
    return "Codex turn state is unknown; refresh the agent to inspect it.";
  }
  if (session.status === "interrupted") {
    return "Codex worker stopped.";
  }
  return "Codex turn stopped.";
}

export function managedAgentStopResultNeedsAttention(
  session: Pick<DesktopManagedAgentSession, "lastError" | "status">,
): boolean {
  return Boolean(session.lastError?.trim() || session.status === "unknown");
}

export function managedAgentSessionDisplayName(
  session: Pick<DesktopManagedAgentSession, "displayName" | "actorLabel" | "runtime">,
): string {
  const chosenName = session.displayName?.trim() || session.actorLabel?.trim();
  if (chosenName) {
    return chosenName;
  }

  const runtime = session.runtime.trim();
  if (runtime && runtime.toLowerCase() !== "codex" && !runtime.toLowerCase().startsWith("codex:")) {
    return runtime;
  }

  return "Local agent";
}

export function managedAgentPermissionProfileStatusLabel(
  status: DesktopManagedAgentPermissionProfile["status"],
): string {
  if (status === "available") return "Available";
  if (status === "gated") return "Gated";
  return "Unsupported";
}

export function managedAgentPermissionProfileSummary(
  profile: Pick<DesktopManagedAgentPermissionProfile, "description" | "detail" | "status">,
): string {
  const prefix = profile.status === "available"
    ? ""
    : `${managedAgentPermissionProfileStatusLabel(profile.status)}: `;
  return `${prefix}${profile.detail?.trim() || profile.description.trim()}`;
}

export type ManagedAgentPermissionProfileSelections =
  Partial<Record<DesktopAgentProviderId, DesktopManagedAgentPermissionProfileId>>;

export function managedAgentPermissionProfileSelectionForProvider(
  provider: Pick<
    DesktopAgentProvider,
    "id" | "defaultPermissionProfileId" | "permissionProfiles"
  > | null | undefined,
  selections: ManagedAgentPermissionProfileSelections,
): DesktopManagedAgentPermissionProfileId | null {
  const profiles = provider?.permissionProfiles ?? [];
  if (!provider || !profiles.length) {
    return null;
  }
  const savedId = selections[provider.id];
  const saved = savedId
    ? profiles.find((profile) => profile.id === savedId && profile.status === "available")
    : null;
  const selected = saved ??
    profiles.find((profile) =>
      profile.id === provider.defaultPermissionProfileId && profile.status === "available"
    ) ??
    profiles.find((profile) => profile.status === "available") ??
    profiles[0] ??
    null;
  return selected?.id ?? null;
}

export function managedAgentPermissionProfileLabel(
  session: Pick<DesktopManagedAgentSession, "permissionProfile" | "permissionProfileId">,
): string {
  return session.permissionProfile?.label?.trim() || session.permissionProfileId.replace(/[_-]+/g, " ");
}

export function activeManagedAgentWorkIndicators(
  sessions: readonly DesktopManagedAgentSession[],
  roomIdentifier: string | null | undefined,
): ManagedAgentWorkIndicator[] {
  return sessions
    .filter((session) =>
      managedAgentSessionMatchesRoom(session, roomIdentifier) &&
      Boolean(session.activeWork) &&
      session.status === "running"
    )
    .map((session) => ({
      id: `${session.id}:${session.activeWork?.eventId || session.activeWork?.startedAt || "work"}`,
      displayName: managedAgentSessionDisplayName(session),
      summary: session.activeWork?.summary?.trim() || "Working in the room.",
      startedAt: session.activeWork?.startedAt || session.updatedAt,
    }))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

export function mergeDesktopManagedAgentParticipants(
  participants: readonly DesktopParticipantSummary[],
  sessions: readonly DesktopManagedAgentSession[],
  roomIdentifier: string | null | undefined,
): DesktopParticipantSummary[] {
  const merged = [...participants];
  for (const session of visibleManagedAgentSessionsForRoom(sessions, roomIdentifier)) {
    if (merged.some((participant) => participantMatchesManagedAgentSession(participant, session))) {
      continue;
    }
    merged.push(desktopManagedAgentSessionToParticipant(session));
  }
  return merged;
}

export function mergeDesktopManagedAgentPresence(
  presenceEntries: readonly DesktopAgentPresence[],
  sessions: readonly DesktopManagedAgentSession[],
  roomIdentifier: string | null | undefined,
): DesktopAgentPresence[] {
  const merged = [...presenceEntries];
  for (const session of visibleManagedAgentSessionsForRoom(sessions, roomIdentifier)) {
    const syntheticPresence = desktopManagedAgentSessionToPresence(session);
    const existingIndex = merged.findIndex((presence) =>
      presenceMatchesManagedAgentSession(presence, session)
    );
    if (existingIndex === -1) {
      merged.push(syntheticPresence);
      continue;
    }
    merged[existingIndex] = mergeManagedAgentPresenceEntry(merged[existingIndex], syntheticPresence);
  }
  return merged;
}

export function mergeReachableAgentPresenceParticipants(
  participants: readonly DesktopParticipantSummary[],
  presenceEntries: readonly DesktopAgentPresence[],
  roomIdentifier: string | null | undefined,
): DesktopParticipantSummary[] {
  const merged = [...participants];
  for (const presence of presenceEntries) {
    if (!isReachableWorkerPresenceForRoom(presence, roomIdentifier)) {
      continue;
    }

    const existingIndex = merged.findIndex((participant) =>
      participantMatchesAgentPresence(participant, presence)
    );
    if (existingIndex === -1) {
      merged.push(agentPresenceToParticipant(presence));
      continue;
    }

    merged[existingIndex] = mergeAgentPresenceParticipant(merged[existingIndex], presence);
  }
  return merged;
}

function visibleManagedAgentSessionsForRoom(
  sessions: readonly DesktopManagedAgentSession[],
  roomIdentifier: string | null | undefined,
): DesktopManagedAgentSession[] {
  return sessions.filter((session) =>
    managedAgentSessionMatchesRoom(session, roomIdentifier)
    && isDeliverableManagedAgentSession(session)
  );
}

function desktopManagedAgentSessionToParticipant(
  session: DesktopManagedAgentSession,
): DesktopParticipantSummary {
  const displayName = managedAgentSessionDisplayName(session);
  const actorLabel = managedAgentSessionActorLabel(session);
  const timestamp = managedAgentSessionTimestamp(session);
  const activityState = managedAgentSessionActivityState(session);
  return {
    participantKey: `desktop-managed-agent:${managedAgentSessionStableKey(session)}`,
    kind: "agent",
    displayName,
    actorLabel,
    agentKey: session.agentKey || managedAgentSessionAgentKey(session),
    githubLogin: null,
    ownerLabel: session.ownerLabel || "Local desktop",
    ideLabel: session.ideLabel || managedAgentSessionIdeLabel(session),
    hiddenAt: null,
    activityState,
    lastSeenAt: timestamp,
    lastRoomActivityAt: timestamp,
    lastLiveHeartbeatAt: timestamp,
    sourceFlags: ["delivery", "presence"],
  };
}

function desktopManagedAgentSessionToPresence(
  session: DesktopManagedAgentSession,
): DesktopAgentPresence {
  const displayName = managedAgentSessionDisplayName(session);
  const actorLabel = managedAgentSessionActorLabel(session);
  const timestamp = managedAgentSessionTimestamp(session);
  const sessionId = session.agentSessionId || session.id;
  const needsAttention = session.status === "blocked" || session.status === "unknown";
  return {
    roomId: session.roomIdentifier,
    actorLabel,
    agentKey: session.agentKey || managedAgentSessionAgentKey(session),
    agentInstanceId: null,
    agentSessionId: session.agentSessionId,
    sessionKind: "worker",
    runtime: session.runtime || session.providerId,
    displayName,
    ownerLabel: session.ownerLabel || "Local desktop",
    ideLabel: session.ideLabel || managedAgentSessionIdeLabel(session),
    repoBranch: session.repoBranch || null,
    status: managedAgentPresenceStatus(session),
    statusText: session.failure?.message || managedAgentSessionStatusLabel(session),
    lastHeartbeatAt: timestamp,
    freshness: needsAttention ? "stale" : "active",
    activityState: needsAttention ? "offline" : managedAgentSessionActivityState(session),
    sourceFlags: ["delivery", "presence"],
    livenessObservation: {
      roomId: session.roomIdentifier,
      agentSessionId: sessionId,
      source: "desktop_managed_agent",
      hostId: session.id,
      hostKind: "desktop",
      hostLabel: "This desktop",
      livenessCapability: session.deliveryMode === "desktop_events" ? "desktop events" : "mcp loop",
      toolBridgeId: `desktop:${session.providerId}:${session.id}`,
      lastObservedAt: timestamp,
      lastToolCallAt: null,
      detail: managedAgentRepoDetail(session),
      createdAt: session.startedAt || timestamp,
      updatedAt: timestamp,
    },
  };
}

function isReachableWorkerPresenceForRoom(
  presence: DesktopAgentPresence,
  roomIdentifier: string | null | undefined,
): boolean {
  const targetRoom = normalizeManagedAgentRoomIdentifier(roomIdentifier);
  const presenceRoom = normalizeManagedAgentRoomIdentifier(presence.roomId);
  return Boolean(
    targetRoom &&
    presenceRoom === targetRoom &&
    presence.sessionKind === "worker" &&
    presence.freshness === "active" &&
    presence.activityState !== "offline" &&
    presence.sourceFlags.includes("delivery")
  );
}

function agentPresenceToParticipant(presence: DesktopAgentPresence): DesktopParticipantSummary {
  const timestamp = presence.lastHeartbeatAt || presence.livenessObservation?.lastObservedAt || new Date(0).toISOString();
  return {
    participantKey: `agent-presence:${normalizeAgentKey(presence.agentSessionId || presence.actorLabel) || presence.actorLabel}`,
    kind: "agent",
    displayName: presence.displayName?.trim() || presence.actorLabel,
    actorLabel: presence.actorLabel,
    agentKey: presence.agentKey,
    githubLogin: null,
    ownerLabel: presence.ownerLabel,
    ideLabel: presence.ideLabel,
    hiddenAt: null,
    activityState: mentionActivityStateForPresence(presence),
    lastSeenAt: timestamp,
    lastRoomActivityAt: null,
    lastLiveHeartbeatAt: timestamp,
    sourceFlags: mergeParticipantSourceFlags([], presence.sourceFlags),
  };
}

function mergeAgentPresenceParticipant(
  participant: DesktopParticipantSummary,
  presence: DesktopAgentPresence,
): DesktopParticipantSummary {
  const timestamp = presence.lastHeartbeatAt || presence.livenessObservation?.lastObservedAt || new Date(0).toISOString();
  return {
    ...participant,
    displayName: participant.displayName || presence.displayName || presence.actorLabel,
    actorLabel: participant.actorLabel || presence.actorLabel,
    agentKey: participant.agentKey || presence.agentKey,
    ownerLabel: participant.ownerLabel || presence.ownerLabel,
    ideLabel: participant.ideLabel || presence.ideLabel,
    hiddenAt: null,
    activityState: participant.activityState === "offline" || participant.hiddenAt
      ? mentionActivityStateForPresence(presence)
      : participant.activityState || mentionActivityStateForPresence(presence),
    lastSeenAt: latestTimestampString(participant.lastSeenAt, timestamp),
    lastLiveHeartbeatAt: latestTimestampString(participant.lastLiveHeartbeatAt, timestamp),
    sourceFlags: mergeParticipantSourceFlags(participant.sourceFlags, presence.sourceFlags),
  };
}

function participantMatchesAgentPresence(
  participant: DesktopParticipantSummary,
  presence: DesktopAgentPresence,
): boolean {
  if (participant.kind !== "agent") return false;
  if (sameNormalized(participant.actorLabel, presence.actorLabel)) return true;
  if (sameSpecificAgentKey(participant.agentKey, presence.agentKey)) return true;
  if (!sameNormalized(participant.displayName, presence.displayName)) return false;
  return Boolean(
    sameNormalized(participant.ideLabel, presence.ideLabel)
    || sameNormalized(participant.ownerLabel, presence.ownerLabel)
  );
}

function mentionActivityStateForPresence(
  presence: Pick<DesktopAgentPresence, "activityState" | "status">,
): DesktopParticipantSummary["activityState"] {
  return presence.status === "idle" ? "away" : presence.activityState;
}

function mergeParticipantSourceFlags(
  existing: readonly DesktopParticipantSummary["sourceFlags"][number][],
  next: readonly DesktopParticipantSummary["sourceFlags"][number][],
): DesktopParticipantSummary["sourceFlags"] {
  return Array.from(new Set([...existing, ...next, "presence" as const]));
}

export function managedAgentRoomBranchMismatch(
  session: { repoBranch?: string | null },
  gitRoom: Pick<DesktopGitRoomInfo, "ref" | "isDefault"> | null | undefined,
): { expectedBranch: string; actualBranch: string | null } | null {
  const expectedBranch = branchScopedGitRoomExpectedBranch(gitRoom);
  if (!expectedBranch) return null;
  const actualBranch = session.repoBranch?.trim() || null;
  if (actualBranch === expectedBranch) return null;
  return { expectedBranch, actualBranch };
}

export function managedAgentRoomBranchMismatchLabel(
  session: { repoBranch?: string | null },
  gitRoom: Pick<DesktopGitRoomInfo, "ref" | "isDefault"> | null | undefined,
): string | null {
  const mismatch = managedAgentRoomBranchMismatch(session, gitRoom);
  if (!mismatch) return null;
  return mismatch.actualBranch
    ? `Expected ${mismatch.expectedBranch}; agent is on ${mismatch.actualBranch}`
    : `Expected ${mismatch.expectedBranch}; agent branch is unknown`;
}

export function managedAgentRepoDetail(
  session: Pick<DesktopManagedAgentSession, "repoBranch" | "repoRootPath">,
  gitRoom?: Pick<DesktopGitRoomInfo, "ref" | "isDefault"> | null,
): string {
  const branch = session.repoBranch?.trim();
  const detail = branch ? `${branch} - ${session.repoRootPath}` : session.repoRootPath;
  const mismatch = managedAgentRoomBranchMismatchLabel(session, gitRoom);
  return mismatch ? `${detail} - ${mismatch}` : detail;
}

function mergeManagedAgentPresenceEntry(
  existing: DesktopAgentPresence,
  managed: DesktopAgentPresence,
): DesktopAgentPresence {
  const sourceFlags = Array.from(new Set([...existing.sourceFlags, ...managed.sourceFlags]));
  return {
    ...existing,
    agentKey: existing.agentKey || managed.agentKey,
    agentSessionId: existing.agentSessionId || managed.agentSessionId,
    displayName: existing.displayName || managed.displayName,
    ownerLabel: existing.ownerLabel || managed.ownerLabel,
    ideLabel: existing.ideLabel || managed.ideLabel,
    runtime: existing.runtime || managed.runtime,
    repoBranch: existing.repoBranch || managed.repoBranch,
    status: existing.status === "idle" && managed.status !== "idle" ? managed.status : existing.status,
    statusText: existing.statusText || managed.statusText,
    lastHeartbeatAt: latestTimestampString(existing.lastHeartbeatAt, managed.lastHeartbeatAt),
    freshness: "active",
    activityState: existing.activityState === "offline" ? managed.activityState : existing.activityState,
    sourceFlags,
    livenessObservation: existing.livenessObservation || managed.livenessObservation,
  };
}

function participantMatchesManagedAgentSession(
  participant: DesktopParticipantSummary,
  session: DesktopManagedAgentSession,
): boolean {
  if (participant.kind !== "agent") return false;
  if (sameNormalized(participant.actorLabel, session.actorLabel)) return true;
  if (sameSpecificAgentKey(participant.agentKey, session.agentKey)) return true;
  if (!sameNormalized(participant.displayName, managedAgentSessionDisplayName(session))) return false;
  return Boolean(
    sameNormalized(participant.ideLabel, session.ideLabel)
    || sameNormalized(participant.ideLabel, managedAgentSessionIdeLabel(session))
    || sameNormalized(participant.ownerLabel, session.ownerLabel)
  );
}

function presenceMatchesManagedAgentSession(
  presence: DesktopAgentPresence,
  session: DesktopManagedAgentSession,
): boolean {
  if (presence.agentSessionId && session.agentSessionId && presence.agentSessionId === session.agentSessionId) {
    return true;
  }
  if (sameNormalized(presence.actorLabel, session.actorLabel)) return true;
  if (sameSpecificAgentKey(presence.agentKey, session.agentKey)) return true;
  if (!sameNormalized(presence.displayName, managedAgentSessionDisplayName(session))) return false;
  return Boolean(
    sameNormalized(presence.ideLabel, session.ideLabel)
    || sameNormalized(presence.ideLabel, managedAgentSessionIdeLabel(session))
    || sameNormalized(presence.ownerLabel, session.ownerLabel)
  );
}

function managedAgentSessionActorLabel(session: DesktopManagedAgentSession): string {
  return session.actorLabel?.trim() || session.displayName?.trim() || managedAgentSessionDisplayName(session);
}

function managedAgentSessionAgentKey(session: DesktopManagedAgentSession): string {
  const runtimeKey = normalizeAgentKey(session.runtime || session.providerId) || "agent";
  return `desktop/${runtimeKey}/${managedAgentSessionStableKey(session)}`;
}

function managedAgentSessionIdeLabel(session: Pick<DesktopManagedAgentSession, "providerId" | "runtime">): string {
  if (session.providerId === "codex") return "Codex";
  if (session.providerId === "claude-code") return "Claude Code";
  return session.runtime || session.providerId;
}

function managedAgentPresenceStatus(
  session: Pick<DesktopManagedAgentSession, "deliveryMode" | "status">,
): DesktopAgentPresence["status"] {
  if (session.status === "blocked" || session.status === "unknown") return "blocked";
  if (session.status === "completed" && session.deliveryMode === "desktop_events") return "idle";
  if (session.status === "completed") return "idle";
  return "working";
}

function managedAgentSessionActivityState(
  session: Pick<DesktopManagedAgentSession, "deliveryMode" | "status">,
): DesktopAgentPresence["activityState"] {
  return managedAgentPresenceStatus(session) === "idle" ? "away" : "active";
}

function managedAgentSessionTimestamp(
  session: Pick<DesktopManagedAgentSession, "startedAt" | "updatedAt">,
): string {
  return session.updatedAt || session.startedAt || new Date(0).toISOString();
}

function managedAgentSessionStableKey(session: DesktopManagedAgentSession): string {
  return normalizeAgentKey(
    session.agentSessionId
    || session.agentKey
    || session.actorLabel
    || session.displayName
    || session.id,
  ) || session.id;
}

function sameNormalized(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftKey = normalizeAgentKey(left);
  const rightKey = normalizeAgentKey(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function sameSpecificAgentKey(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftKey = specificAgentKey(left);
  const rightKey = specificAgentKey(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function latestTimestampString(left: string | null | undefined, right: string | null | undefined): string {
  const leftTime = Date.parse(String(left || ""));
  const rightTime = Date.parse(String(right || ""));
  if (Number.isNaN(leftTime)) return right || left || new Date(0).toISOString();
  if (Number.isNaN(rightTime)) return left || right || new Date(0).toISOString();
  return rightTime > leftTime ? String(right) : String(left);
}

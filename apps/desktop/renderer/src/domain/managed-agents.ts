import type {
  DesktopAgentPresence,
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderSetupAction,
  DesktopGitRoomInfo,
  DesktopManagedAgentPermissionProfile,
  DesktopManagedAgentPermissionProfileId,
  DesktopParticipantSummary,
  DesktopRoomInfo,
  DesktopRoomMessage,
  DesktopSupervisorManifestEntry,
  RepoStatus,
  RepoWorktreeEntry,
} from "../../../electron/ipc-types";
import { orbStateForActivity, orbStateForTurn, type ActivityOrbState } from "./activity-orb-state";
import { isGenericAgentProviderLabel } from "./agent-provider";
import { normalizeAgentKey } from "./agents";
import { ACTIVE_AGENT_PRESENCE_WINDOW_MS } from "../../../../../src/shared/agent-presence";
import { supervisedAgentDisplayLabel } from "./codenames";
import { BACKGROUND_WORK_METHOD, humanFacingSupervisorActivitySummary, isHumanVisibleSupervisorActivity, liveActivityEchoText } from "../../../../../shared/live-activity-summary.mjs";
// The owner's echo and the line published to room presence share one source.
export {
  humanFacingSupervisorActivitySummary,
  isHumanVisibleSupervisorActivity,
  LIVE_ACTIVITY_ECHO_MAX_LENGTH,
  liveActivityEchoText,
} from "../../../../../shared/live-activity-summary.mjs";

/** Current native-owner progress, never inferred from saved activity or a timer. */
export function agentCompactionProgress(entry: Pick<DesktopSupervisorManifestEntry,
  "provider" | "providerProgress" | "desiredState" | "observedState" | "condition">) {
  return ["claude-code", "open-model"].includes(entry.provider) && entry.desiredState === "running"
    && entry.condition === "none" && !["stopped", "stopping", "failed"].includes(entry.observedState)
    && entry.providerProgress?.state === "compacting" ? entry.providerProgress : null;
}

export interface AgentSetupConfirmation {
  providerId: DesktopAgentProviderId;
  action: DesktopAgentProviderSetupAction;
}

/**
 * A provider opts in to durable supervision only after its native evidence
 * cells prove that lifecycle.
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

  // A room with no project context at all (no git room, no durable project) is
  // genuinely repo-less. The agent must NOT be pointed at HOME: returning null
  // declares "no source repo" so the daemon provisions a private, empty scratch
  // workspace for it instead (see ensureWorkAttempt's ephemeral branch).
  return null;
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
    case "read_only": return {
      permissionMode: "dontAsk",
      dangerouslySkipPermissions: false,
      tools: ["Read", "Glob", "Grep"],
      allowedTools: ["mcp__letagents__*"],
      settingSources: "",
    };
    case "ask_before_write": return { permissionMode: "default" };
    case "auto_review": return { permissionMode: "auto" };
    case "full_access": return { permissionMode: "bypassPermissions" };
    default: throw new Error("Choose an available Claude Code permission profile before supervised launch.");
  }
}

export function normalizeManagedAgentRoomIdentifier(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
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
 * Project a durable bounded turn into the existing chat work indicator. The
 * turn owns visibility; native activity only refines the copy. An individual
 * Codex item may complete while the surrounding room turn is still active, so
 * item-level idle events must never make the whole agent disappear.
 */
export function supervisedAgentWorkIndicators(
  entries: readonly DesktopSupervisorManifestEntry[],
  presence: readonly Pick<DesktopAgentPresence, "agentSessionId" | "displayName" | "actorLabel">[],
  roomIdentifier: string | null | undefined,
  resourceFreshness: "fresh" | "stale" = "fresh",
): ManagedAgentWorkIndicator[] {
  const room = normalizeManagedAgentRoomIdentifier(roomIdentifier);
  return entries
    .filter((entry) =>
      normalizeManagedAgentRoomIdentifier(entry.roomId) === room &&
      entry.agentSessionBindingState === "active" &&
      entry.desiredState === "running" &&
      entry.condition === "none" &&
      entry.roomAgentState?.connection.state === "connected" &&
      isVisibleRoomTurnState(entry.roomAgentState.turn.state)
    )
    .flatMap((entry) => {
      const turn = entry.roomAgentState!.turn;
      // A terminal receipt can arrive before the active-turn projection clears.
      // Do not keep saying "Writing" after this exact turn chose not to reply.
      // Matching the native turn as well as the inbox preserves later retries.
      const settled = entry.deliveryReceipts?.some(receipt =>
        Boolean(turn.inboxItemId && turn.providerTurnId)
        && receipt.inboxItemId === turn.inboxItemId
        && receipt.providerTurnId === turn.providerTurnId
        && receipt.sourceMessageId === turn.sourceMessageId
        && (receipt.state.startsWith("acknowledged") || receipt.state.startsWith("cancelled")));
      if (settled) return [];
      const turnStartedAt = currentRoomTurnStartedAt(entry);
      const turnStartedAtMs = Date.parse(turnStartedAt ?? "");
      const nativeActivityIsCurrent = entry.observedState === "working"
        && entry.nativeLiveness.state === "active";
      const latest = [...entry.activity]
        .sort((left, right) => right.sequence - left.sequence)
        .find((event) => isHumanVisibleSupervisorActivity(event)
          && (event.status === "working" || event.status === "reviewing")
          && (Number.isFinite(turnStartedAtMs)
            ? Date.parse(event.observedAt) >= turnStartedAtMs
            : nativeActivityIsCurrent));
      const boundPresence = entry.agentSessionId
        ? presence.find((candidate) => candidate.agentSessionId === entry.agentSessionId)
        : null;
      return [{
        // Stable per-entry id so the indicator updates its echo in place as the
        // native stream progresses instead of remounting (and re-animating) on
        // every new activity event.
        id: entry.id,
        // Presence carries the worker's post-registration name. Associate it
        // with this exact durable entry before projecting away a legacy suffix.
        displayName: supervisedAgentDisplayLabel(
          boundPresence?.displayName || boundPresence?.actorLabel || entry.displayName,
          entry.id,
        ),
        activity: latest ? orbStateForActivity(latest) : orbStateForTurn(turn.state),
        summary: resourceFreshness === "fresh" && agentCompactionProgress(entry) ? "Compacting conversation" : latest
          ? humanFacingSupervisorActivitySummary(latest)
          : roomTurnFallbackSummary(turn.state),
        // The turn has its answer and only waits: its owner may have the answer posted now. The wait must be
        // this turn's own, so the start of the turn must be known: activity from before it is another turn's.
        ...(resourceFreshness === "fresh" && turn.state === "responding" && Number.isFinite(turnStartedAtMs)
          && latest?.method.trim().toLowerCase() === BACKGROUND_WORK_METHOD ? { waitsForBackgroundWork: true } : {}),
        startedAt: turnStartedAt
          ?? latest?.observedAt
          ?? entry.roomAgentState?.connection.observedAt
          ?? entry.bindingUpdatedAt
          ?? entry.createdAt,
        agentSessionId: entry.agentSessionId,
        agentKey: entry.agentKey,
        sourceMessageId: turn.sourceMessageId,
      }];
    })
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

function isVisibleRoomTurnState(state: string): boolean {
  return state === "dispatching"
    || state === "responding"
    || state === "publishing"
    || state === "retrying";
}

function currentRoomTurnStartedAt(entry: DesktopSupervisorManifestEntry): string | null {
  const turn = entry.roomAgentState?.turn;
  if (!turn) return null;
  const receipt = entry.deliveryReceipts?.find((candidate) =>
    (Boolean(turn.inboxItemId) && candidate.inboxItemId === turn.inboxItemId)
    || (Boolean(turn.sourceMessageId) && candidate.sourceMessageId === turn.sourceMessageId));
  if (!receipt) return null;
  for (let index = receipt.timeline.length - 1; index >= 0; index -= 1) {
    const event = receipt.timeline[index];
    if (event?.phase === "turn_started") return event.observedAt;
  }
  return null;
}

function roomTurnFallbackSummary(state: string): string {
  if (state === "dispatching") return "Preparing a response";
  if (state === "publishing") return "Sending the response";
  if (state === "retrying") return "Trying again";
  return "Thinking";
}

export interface ManagedAgentWorkIndicator {
  id: string;
  displayName: string;
  summary: string;
  startedAt: string;
  /** Exact room identity used to retire stale progress after this agent speaks. */
  agentSessionId?: string | null;
  agentKey?: string | null;
  /** Exact activating room message; establishes causal order without comparing host clocks. */
  sourceMessageId?: string | null;
  /** Routed participant whose native turn may still be held by the room. */
  awaitingRoomTurn?: true;
  /** The agent is not working: it waits for the time of its automatic attempt. The row rests. */
  waiting?: true;
  /** The turn is held open for background work. Its answer exists, and its owner can end the wait. The row works: something runs. */
  waitsForBackgroundWork?: boolean;
  /** Another member's agent, known only from room presence: shown as a label, with no control and no live stream. */
  remote?: true;
  /** What the agent does now, from its native activity or turn state; it chooses the live orb. */
  activity?: ActivityOrbState;
}

/** Default number of concurrent work indicators shown before collapsing. */
export const WORK_INDICATOR_VISIBLE_LIMIT = 3;

/**
 * Retire progress only when the same exact agent has published after the room
 * message that activated this turn. Message order is the causal clock; local
 * provider and remote server timestamps are deliberately never compared.
 * Display names are excluded because two durable agents may share one.
 */
export function workIndicatorSupersededByAgentMessage(
  indicator: ManagedAgentWorkIndicator,
  messages: readonly Pick<DesktopRoomMessage, "id" | "agentIdentity">[],
): boolean {
  // A reply to an earlier request cannot finish this pending exchange.
  if (indicator.awaitingRoomTurn) return false;
  const sourceMessageId = indicator.sourceMessageId?.trim() || null;
  if (!sourceMessageId) return false;
  const sourceIndex = messages.findIndex((message) => message.id === sourceMessageId);
  if (sourceIndex < 0) return false;
  const indicatorSessionId = indicator.agentSessionId?.trim() || null;
  const indicatorAgentKey = normalizeAgentKey(indicator.agentKey);
  if (!indicatorSessionId && !indicatorAgentKey) return false;
  return messages.some((message, messageIndex) => {
    if (messageIndex <= sourceIndex) return false;
    const messageSessionId = message.agentIdentity?.agentSessionId?.trim() || null;
    if (indicatorSessionId && messageSessionId) return indicatorSessionId === messageSessionId;
    const messageAgentKey = normalizeAgentKey(message.agentIdentity?.agentKey);
    return Boolean(indicatorAgentKey && messageAgentKey && indicatorAgentKey === messageAgentKey);
  });
}

export interface CollapsedWorkIndicators {
  visible: ManagedAgentWorkIndicator[];
  hiddenCount: number;
  /** How many of the hidden rows are agents that wait to try again. The rest work. */
  hiddenWaitingCount: number;
}

/**
 * Keep the work-indicator area unobtrusive when many agents are active at once
 * (EmmyMay's ten-agent noise constraint): show the most recent `maxVisible` and
 * report the rest as an overflow count instead of an unbounded list.
 *
 * The rows go in three kinds, in this order, whether or not any is hidden: a row of
 * work that carries a control (a turn held open for background work, with "Post
 * answer now"), because it is the oldest row of work and, hidden, its control
 * could not be used; the other rows of work; and the rows at rest, the agents that
 * wait to try again. A row at rest never hides a row of work.
 *
 * Inside a kind the rows keep the order that they were given, so a row never jumps
 * because a time ticked. Time decides only when a kind does not fit and a row would
 * be hidden: that kind is ordered by time, the most recent rows of work first and
 * the rows at rest that try first first, and the places go to the first of them.
 * The time of a row at rest is the future time of its attempt, which is not a time
 * to rank by when nothing is hidden.
 */
export function collapseWorkIndicators(
  indicators: readonly ManagedAgentWorkIndicator[],
  maxVisible: number = WORK_INDICATOR_VISIBLE_LIMIT,
): CollapsedWorkIndicators {
  if (maxVisible <= 0) return { visible: [...indicators], hiddenCount: 0, hiddenWaitingCount: 0 };
  const visible: ManagedAgentWorkIndicator[] = [];
  let room = maxVisible;
  let hiddenCount = 0;
  let hiddenWaitingCount = 0;
  for (const kind of ["control", "work", "waiting"] as const) {
    const rows = indicators.filter((work) => (work.waiting ? "waiting" : work.waitsForBackgroundWork ? "control" : "work") === kind);
    // When every row of this kind fits, they stay as given. When some do not, the places go by time.
    const shown = rows.length <= room ? rows
      : [...rows].sort((left, right) => kind === "waiting" ? left.startedAt.localeCompare(right.startedAt) : right.startedAt.localeCompare(left.startedAt)).slice(0, room);
    visible.push(...shown);
    room -= shown.length;
    hiddenCount += rows.length - shown.length;
    if (kind === "waiting") hiddenWaitingCount += rows.length - shown.length;
  }
  return { visible, hiddenCount, hiddenWaitingCount };
}

/** What the strip says of the rows that it does not show: "+2 more agents working", "+1 more agent waiting to try again". */
export function workIndicatorOverflowLabel(collapsed: Pick<CollapsedWorkIndicators, "hiddenCount" | "hiddenWaitingCount">): string {
  const { hiddenCount, hiddenWaitingCount } = collapsed;
  const what = hiddenWaitingCount === 0 ? "working" : hiddenWaitingCount === hiddenCount ? "waiting to try again" : "working or waiting to try again";
  return `+${hiddenCount} more ${hiddenCount === 1 ? "agent" : "agents"} ${what}`;
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

function specificAgentKey(value: string | null | undefined): string {
  const normalized = normalizeAgentKey(value);
  if (!normalized || !/[/:]/.test(normalized)) {
    return "";
  }
  return normalized;
}

export function isExternalMcpProviderReady(
  provider: Pick<DesktopAgentProvider, "capabilities"> | null | undefined,
  preflight: Pick<DesktopAgentProviderPreflight, "status" | "mcpStatus"> | null | undefined,
): boolean {
  return Boolean(
    provider &&
    !hasSupervisedRuntime(provider) &&
    preflight?.status === "ready" &&
    preflight.mcpStatus === "installed",
  );
}

export function agentProviderNeedsDesktopRepo(
  provider: Pick<DesktopAgentProvider, "capabilities"> | null | undefined,
): boolean {
  return hasSupervisedRuntime(provider);
}

export function shouldShowOpenModelConfig(
  provider: Pick<DesktopAgentProvider, "id" | "capabilities"> | null | undefined,
): boolean {
  return provider?.id === "open-model" && hasSupervisedRuntime(provider);
}

export function shouldShowManagedModelSelector(
  provider: Pick<DesktopAgentProvider, "id" | "capabilities"> | null | undefined,
): boolean {
  return hasSupervisedRuntime(provider);
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
    "Call read_messages once, then call get_board once so you know the work in flight and who holds it. Do not claim unassigned tasks on your own; work starts when a task is assigned to you.",
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
    return `LetAgents will install its managed ${name} execution engine on this machine after confirmation. External provider CLIs remain user-managed.`;
  }
  return `LetAgents will update ${name}'s agent app configuration to add the LetAgents connection after confirmation.`;
}

export function managedAgentPermissionProfileStatusLabel(
  status: DesktopManagedAgentPermissionProfile["status"],
): string {
  if (status === "available") return "Available";
  if (status === "gated") return "Not available yet";
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

export function supervisedCursorPermissionProfilePresentation(
  profile: DesktopManagedAgentPermissionProfile,
): DesktopManagedAgentPermissionProfile {
  if (profile.id === "sandboxed_write") {
    return {
      ...profile,
      label: "Workspace writes",
      description: "Can inspect files, edit code, and run project tools in a separate copy of your project.",
      detail: "Cursor restricts file and command access. LetAgents checks for conflicts before copying changes back. Files ignored by Git stay read-only, and Git history is kept.",
    };
  }
  if (profile.id === "full_access") {
    return {
      ...profile,
      label: "Full access",
      description: "Can change files on this Mac and run commands without approval prompts.",
      detail: "Changes apply directly to the agent's working directory. Commands can access files outside the project and use the network, including Git pushes and pull requests with available credentials. LetAgents manages room messages and Cursor sign-in separately.",
    };
  }
  if (profile.id === "read_only") {
    return {
      ...profile,
      description: "Inspects and plans within the launched workspace without editing it.",
      detail: "Choose this only when the agent should analyze the project without making changes.",
    };
  }
  return profile;
}

export function supervisedPermissionProfilePresentation(
  providerId: DesktopAgentProviderId | null | undefined,
  profile: DesktopManagedAgentPermissionProfile,
  context?: { hasProject: boolean },
): DesktopManagedAgentPermissionProfile {
  if (providerId === "cursor") {
    const presented = supervisedCursorPermissionProfilePresentation(profile);
    if (context?.hasProject === false && (profile.id === "sandboxed_write" || profile.id === "full_access")) {
      return { ...presented, status: "unsupported", detail: "Connect a project to use workspace writes." };
    }
    return presented;
  }
  if (profile.id === "auto_review" && providerId === "claude-code") {
    return { ...profile, status: "available",
      description: "Lets Claude check each action before it runs. Actions it judges safe run without asking.",
      detail: "Claude blocks actions it judges risky. Anything a room message asks for counts as approved, including commands that reach outside your project. Other Claude settings do not apply." };
  }
  if (profile.id === "auto_review" && providerId === "open-model") {
    return { ...profile, status: "available",
      description: "Lets LetAgents review each command before it runs. Routine commands and edits to project files run without asking.",
      detail: "Reading and checking commands are sent to LetAgents and to Jev, a decision model, for review. Committing, fetching, reading pull requests, and pushing to the agent's own LetAgents branch run without asking. A command that deletes, installs, force-pushes, or pushes anywhere else still asks you, and so does an edit to a settings or credentials file. Reading project files and looking things up on the web are not reviewed. The agent's own tools cannot open files outside the project." };
  }
  if (profile.id === "auto_review" && providerId === "codex") {
    return { ...profile, status: "available",
      description: "Lets Codex decide, without asking you, when a command may go beyond its working folder.",
      detail: "Can change files only in its working folder and temporary folders, with no network access, until Codex approves more. Anything a room message asks for counts as approved, including commands that reach outside your project." };
  }
  if (profile.id === "read_only" && providerId === "codex") {
    return { ...profile, status: "available", risk: "medium",
      description: "Can read files on this Mac, also outside your project, and read and post in the room.",
      detail: "Cannot change files. Its commands cannot use the network, and web search is off. Its commands cannot read your Codex sign-in file. It asks for no approval: a command that needs more is refused. Your saved Codex command rules do not apply to it. It cannot change the task board, join rooms or submit reviews." };
  }
  if (profile.id !== "ask_before_write"
    || (providerId !== "codex" && providerId !== "open-model" && providerId !== "claude-code")) return profile;
  if (providerId === "claude-code") {
    return { ...profile, status: "available",
      description: "Requires approval before Claude can change files or run write-capable commands.",
      detail: "Commands that only read the project, its history, or its pull requests run without asking. Each approval allows one action. Other Claude settings do not apply. LetAgents room tools remain available." };
  }
  if (providerId === "open-model") {
    return {
      ...profile,
      status: "available",
      description: "Requires approval before OpenCode can run shell commands or change files.",
      detail: "Commands and file changes need approval. Reading files and using LetAgents room tools do not.",
    };
  }
  return {
    ...profile,
    status: "available",
    description: "Requires approval before Codex can run write-capable commands or apply file changes.",
    detail: "Starts with read-only file access and no network access. Requests approval when it needs more access.",
  };
}

const NOTHING_BLOCKED = "Nothing is blocked: it can reach the network and files outside the project.";
const CURSOR_NO_NETWORK = "No network access: can't push or open PRs.";

/**
 * What an access level withholds, stated on its card. Each line follows the
 * native authority the daemon launches with (provider-configuration.ts), so a
 * label such as "compatibility" cannot imply access the agent does not get.
 * Levels a provider cannot use yet have no line; their card already says so.
 */
const SUPERVISED_PERMISSION_PROFILE_LIMITS: Partial<Record<
  DesktopAgentProviderId,
  Partial<Record<DesktopManagedAgentPermissionProfileId, string>>
>> = {
  codex: {
    full_access: NOTHING_BLOCKED,
    ask_before_write: "Without your approval: no file changes, no write commands and no network access.",
    auto_review: "No network access and no changes outside its working folder, unless Codex approves more.",
    read_only: "Can't change files. Its commands can't use the network, and web search is off. Can't change the task board, join rooms or submit reviews. It asks for no approval.",
  },
  "claude-code": {
    read_only: "Can't change files, run commands or browse the web.",
    ask_before_write: "Can't change files or run write commands until you approve each one.",
    auto_review: "Blocks only what Claude judges risky. It doesn't ask you first.",
    full_access: NOTHING_BLOCKED,
  },
  "open-model": {
    full_access: NOTHING_BLOCKED,
    ask_before_write: "Can't run commands or change files until you approve each one.",
    auto_review: "Can't open files outside the project. Commands that delete, publish, install or reach the network ask you first.",
  },
  // Only Cursor's restricted profiles use the outer macOS sandbox.
  cursor: {
    read_only: `Can't edit files. ${CURSOR_NO_NETWORK}`,
    sandboxed_write: `Can't write to files on this Mac directly. ${CURSOR_NO_NETWORK}`,
    full_access: NOTHING_BLOCKED,
  },
};

/**
 * The same lines for an agent that uses its owner's own setup. The owner's
 * allow rules, hooks, MCP tools and plugins are then outside what an access
 * level withholds, so each line says what still asks and what does not.
 */
const OWNER_SETUP_PERMISSION_PROFILE_LIMITS: Partial<Record<
  DesktopAgentProviderId,
  Partial<Record<DesktopManagedAgentPermissionProfileId, string>>
>> = {
  codex: {
    ask_before_write: "Without your approval, Codex's own commands change no files and have no network access. Your own MCP tools, hooks and plugins are not held to this.",
    auto_review: "Codex's own commands have no network access and change nothing outside its working folder, unless Codex approves more. Your own MCP tools, hooks and plugins are not held to this.",
    read_only: "Codex's own commands change no files and have no network access, web search is off, and it asks for no approval. Your own MCP tools, hooks and plugins are not held to this.",
  },
  "claude-code": {
    read_only: "Its own tools can't change files, run commands or browse the web. Your MCP tools and hooks can, where your own Claude Code settings allow them.",
    ask_before_write: "Asks before it changes files or runs write commands, except where your own Claude Code rules already allow it. Your hooks run without asking.",
    auto_review: "Blocks only what Claude judges risky, after your own Claude Code rules have allowed what they allow. It doesn't ask you first.",
  },
};

export function supervisedPermissionProfileLimits(
  providerId: DesktopAgentProviderId | string | null | undefined,
  profile: Pick<DesktopManagedAgentPermissionProfile, "id" | "status">,
  /** The agent is set to use its owner's own setup. */
  ownSetup = false,
): string | null {
  if (profile.status !== "available") return null;
  const provider = (providerId === "claude" ? "claude-code" : providerId) as DesktopAgentProviderId;
  return (ownSetup ? OWNER_SETUP_PERMISSION_PROFILE_LIMITS[provider]?.[profile.id] : undefined)
    ?? SUPERVISED_PERMISSION_PROFILE_LIMITS[provider]?.[profile.id] ?? null;
}

/** Shown before launch. Auto still has a reviewer, so the Full access notice would mislead. */
export function autoReviewNotice(providerName: string, providerId?: DesktopAgentProviderId | null): string {
  if (providerId === "open-model") {
    return `LetAgents decides which of ${providerName}'s commands are safe instead of asking you, and sends each command to LetAgents and Jev to do it. A command it allows can run the project's own scripts, which can do anything the project defines. Use only with projects you trust.`;
  }
  return `${providerName} decides which actions are safe instead of asking you. Anything a room message asks for counts as approved, including commands that reach outside your project. Use only in rooms where you trust everyone who can post.`;
}

export type ManagedAgentPermissionProfileSelections =
  Partial<Record<DesktopAgentProviderId, DesktopManagedAgentPermissionProfileId>>;

export function managedAgentPermissionProfileSelectionForProvider(
  provider: Pick<
    DesktopAgentProvider,
    "id" | "defaultPermissionProfileId" | "permissionProfiles"
  > | null | undefined,
  selections: ManagedAgentPermissionProfileSelections,
  preferredProfileId?: DesktopManagedAgentPermissionProfileId | null,
): DesktopManagedAgentPermissionProfileId | null {
  const profiles = provider?.permissionProfiles ?? [];
  if (!provider || !profiles.length) {
    return null;
  }
  const savedId = selections[provider.id];
  const saved = savedId
    ? profiles.find((profile) => profile.id === savedId && profile.status === "available")
    : null;
  const preferred = preferredProfileId
    ? profiles.find((profile) => profile.id === preferredProfileId && profile.status === "available")
    : null;
  const selected = saved ??
    preferred ??
    profiles.find((profile) =>
      profile.id === provider.defaultPermissionProfileId && profile.status === "available"
    ) ??
    profiles.find((profile) => profile.status === "available") ??
    profiles[0] ??
    null;
  return selected?.id ?? null;
}

/**
 * Daemon-inbox agents do not have to exist in the legacy managed-session
 * registry. Project the live supervisor truth into Chat as well as Activity,
 * while retaining the canonical server identity used for mention routing.
 */
export function mergeDesktopSupervisorAgentParticipants(
  participants: readonly DesktopParticipantSummary[],
  entries: readonly DesktopSupervisorManifestEntry[],
  roomIdentifier: string | null | undefined,
): DesktopParticipantSummary[] {
  const merged = [...participants];
  for (const entry of entries) {
    if (!supervisorEntryIsMentionable(entry, roomIdentifier)) continue;
    const existingIndex = merged.findIndex((participant) =>
      participant.kind === "agent"
      && Boolean(entry.agentKey)
      && normalizeAgentKey(participant.agentKey) === normalizeAgentKey(entry.agentKey)
    );
    const projected = desktopSupervisorEntryToParticipant(entry);
    if (existingIndex === -1) {
      merged.push(projected);
      continue;
    }
    const existing = merged[existingIndex];
    merged[existingIndex] = {
      ...existing,
      ...projected,
      // The supervisor projection owns reachability, but the room API owns
      // participant identity. Do not replace a server-provided owner label
      // or composite actor label with local runtime fallback metadata.
      actorLabel: existing.actorLabel || projected.actorLabel,
      ownerLabel: existing.ownerLabel || projected.ownerLabel,
      ideLabel: isGenericAgentProviderLabel(existing.ideLabel) ? projected.ideLabel : existing.ideLabel,
      sourceFlags: [...new Set([...existing.sourceFlags, ...projected.sourceFlags])],
    };
  }
  return merged;
}

function supervisorEntryIsMentionable(
  entry: DesktopSupervisorManifestEntry,
  roomIdentifier: string | null | undefined,
): boolean {
  if (normalizeManagedAgentRoomIdentifier(entry.roomId) !== normalizeManagedAgentRoomIdentifier(roomIdentifier)) {
    return false;
  }
  if (!entry.agentKey?.trim() || !entry.roomAgentState) return false;
  if (entry.desiredState === "stopped" && entry.observedState === "stopped") return false;
  return entry.roomAgentState.connection.state === "connected"
    && (entry.roomAgentState.ingress?.state ?? "observing") === "observing";
}

function desktopSupervisorEntryToParticipant(
  entry: DesktopSupervisorManifestEntry,
): DesktopParticipantSummary {
  const timestamp = entry.bindingUpdatedAt || entry.createdAt;
  const displayName = supervisedAgentDisplayLabel(entry.displayName, entry.id);
  return {
    participantKey: `desktop-supervisor-agent:${entry.id}`,
    kind: "agent",
    displayName,
    actorLabel: entry.displayName,
    agentKey: entry.agentKey ?? null,
    githubLogin: null,
    // Canonical agent keys are server-owned `<owner login>/<agent name>`
    // identities. They are a truthful fallback while the room participant
    // snapshot catches up; "Local desktop" describes a host, not an owner.
    ownerLabel: supervisorOwnerLabelFromAgentKey(entry.agentKey),
    ideLabel: managedAgentProviderLabel(entry.provider),
    hiddenAt: null,
    activityState: "active",
    lastSeenAt: timestamp,
    lastRoomActivityAt: timestamp,
    lastLiveHeartbeatAt: entry.workplaceLiveness.observedAt || timestamp,
    sourceFlags: ["delivery", "presence"],
  };
}

function supervisorOwnerLabelFromAgentKey(agentKey: string | null | undefined): string | null {
  const normalized = agentKey?.trim() || "";
  const separator = normalized.indexOf("/");
  if (separator <= 0) return null;
  return normalized.slice(0, separator).trim() || null;
}

/**
 * Rows for the live strip from room presence: agents that work in this room
 * and that this desktop does not run. The text is the line the agent's own
 * daemon published (the same line its owner sees), else "Working". Local
 * supervisor entries have rows of their own, so every agent with a local
 * identity is left out, and so is every agent that already has a row.
 */
export function remoteAgentWorkIndicators(
  presenceEntries: readonly DesktopAgentPresence[],
  entries: readonly Pick<DesktopSupervisorManifestEntry, "agentKey" | "agentSessionId">[],
  existing: readonly Pick<ManagedAgentWorkIndicator, "agentKey" | "agentSessionId">[] = [],
  nowMs: number = Date.now(),
): ManagedAgentWorkIndicator[] {
  const localSessions = new Set<string>();
  const localKeys = new Set<string>();
  for (const local of [...entries, ...existing]) {
    if (local.agentSessionId) localSessions.add(local.agentSessionId);
    const key = normalizeAgentKey(local.agentKey);
    if (key) localKeys.add(key);
  }
  const rows = new Map<string, ManagedAgentWorkIndicator>();
  for (const presence of presenceEntries) {
    const key = normalizeAgentKey(presence.agentKey);
    const identity = key || presence.agentSessionId;
    const heartbeatMs = Date.parse(presence.lastHeartbeatAt);
    if (!identity || rows.has(identity)
      || (presence.status !== "working" && presence.status !== "reviewing")
      || !Number.isFinite(heartbeatMs) || nowMs - heartbeatMs > ACTIVE_AGENT_PRESENCE_WINDOW_MS
      || (presence.agentSessionId && localSessions.has(presence.agentSessionId))
      || (key && localKeys.has(key))) continue;
    rows.set(identity, {
      id: `remote:${identity}`,
      displayName: presence.displayName?.trim() || presence.actorLabel,
      summary: liveActivityEchoText(presence.statusText?.trim() || "Working"),
      // Unknown: presence tells when the agent was last seen, not when its work started.
      startedAt: "",
      agentSessionId: presence.agentSessionId,
      agentKey: presence.agentKey,
      remote: true,
    });
  }
  return [...rows.values()];
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

    const canonicalIndex = merged.findIndex((participant) =>
      participant.kind === "agent" && sameSpecificAgentKey(participant.agentKey, presence.agentKey));
    const actorIndex = canonicalIndex === -1 ? merged.findIndex((participant) =>
      sameNormalized(participant.actorLabel, presence.actorLabel)
      && participantMatchesAgentPresence(participant, presence)) : -1;
    const fallbackIndices = canonicalIndex === -1 && actorIndex === -1
      ? merged.flatMap((participant, index) => participantMatchesAgentPresence(participant, presence) ? [index] : [])
      : [];
    const existingIndex = canonicalIndex !== -1 ? canonicalIndex
      : actorIndex !== -1 ? actorIndex
      : fallbackIndices.length === 1 ? fallbackIndices[0] : -1;
    if (existingIndex === -1) {
      merged.push(agentPresenceToParticipant(presence));
      continue;
    }

    merged[existingIndex] = mergeAgentPresenceParticipant(merged[existingIndex], presence);
  }
  return merged;
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
  const participantKey = specificAgentKey(participant.agentKey);
  const presenceKey = specificAgentKey(presence.agentKey);
  if (participantKey && presenceKey) return participantKey === presenceKey;
  if (participant.ownerLabel?.trim() && presence.ownerLabel?.trim()
    && !sameNormalized(participant.ownerLabel, presence.ownerLabel)) return false;
  if (sameNormalized(participant.actorLabel, presence.actorLabel)) return true;
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

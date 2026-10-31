import type { DesktopAgentPresence } from '../../../electron/ipc-types';
import type { AgentInspectorSelection } from '../components/desktop/content/desktop-chat-message/types';
import type { AgentInspectorActionIntent, AgentInspectorProjection } from './agent-inspector';
import { agentCompactionProgress } from './managed-agents';
import { agentScheduledRetry, scheduledRetryDetail } from './scheduled-retry';

export interface InspectorSignal {
  state: string;
  label: string;
  detail: string;
  tone: 'green' | 'blue' | 'amber' | 'violet' | 'red' | 'neutral';
  moving: boolean;
}

export function agentInspectorProviderLabel(provider: string): string {
  return ({ 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', 'open-model': 'Open Model' } as Record<string, string>)[provider] || provider;
}

export function agentInspectorActionErrorMessage(
  kind: AgentInspectorActionIntent["kind"],
  error: unknown,
): string {
  const detail = error instanceof Error ? error.message : "";
  if ((kind === "reconnect" || kind === "reconnect_runtime") && /previous provider runtime is unavailable|no longer has a live runtime/i.test(detail)) {
    return "This provider process has stopped. Open Diagnostics → Agent runtime for recovery options to continue with the same identity and workspace.";
  }
  if (kind === "recover" && /cannot prove that the previous provider process stopped/i.test(detail)) {
    return "LetAgents could not safely prove the old provider stopped. No replacement was started.";
  }
  if (kind === "recover" && /desktop credentials are required/i.test(detail)) {
    return "LetAgents could not restore this agent’s room credentials. Try recovery again.";
  }
  return detail || "The agent action could not be completed.";
}

/** `nowMs` moves on each second while the agent waits to try again, so what is said of that wait is right at its time. */
export function agentInspectorSignal(projection: AgentInspectorProjection, nowMs = Date.now()): InspectorSignal {
  if (projection.resourceFreshness === 'stale') return {
    state: 'stale', label: 'Updates delayed', detail: 'Showing the last known state. Controls return when the connection does.', tone: 'amber', moving: false,
  };
  if (!projection.runtimeExited && agentCompactionProgress(projection.entry)) return {
    state: 'compacting', label: 'Compacting context', detail: 'Summarizing earlier context.', tone: 'violet', moving: true,
  };
  const state = projection.overallState;
  if (projection.deliveryProgress?.phase === 'publishing') return {
    state: 'publishing', label: 'Publishing reply', detail: 'Sending the response to the room.', tone: 'blue', moving: true,
  };
  // The agent is online, and waits to try unfinished work again by itself. It does not need its owner yet.
  const retry = state === 'online' ? agentScheduledRetry(projection.entry.deliveryReceipts) : null;
  if (retry) return {
    state: 'retry_scheduled', label: 'Waiting to try again', detail: scheduledRetryDetail(retry, nowMs), tone: 'amber', moving: false,
  };
  const tone = state === 'online' ? 'green' : state === 'responding' ? 'blue'
    : ['starting', 'recovering', 'reconnecting', 'restoring_conversation'].includes(state) ? 'amber'
    : state === 'needs_attention' ? 'red' : 'neutral';
  return {
    state, label: state === 'responding' ? 'Responding' : projection.overallLabel,
    detail: state === 'responding' ? 'Replying to the room.' : state === 'online' ? 'Ready for room work.'
      : projection.now?.kind === 'attention' ? projection.now.summary : projection.overallDetail,
    tone, moving: tone === 'blue' || tone === 'amber',
  };
}

/** Shared presence changes presentation only. It can never grant host controls. */
export function sharedAgentInspectorPresentation(
  selection: AgentInspectorSelection,
  presence: readonly DesktopAgentPresence[],
  roomId: string,
  viewerLogin?: string | null,
  sourceFresh = true,
): { owner: boolean; ownerLabel: string; provider: string; signal: InspectorSignal } {
  const matches = presence.filter(item => item.roomId === roomId
    && (selection.agentSessionId ? item.agentSessionId === selection.agentSessionId
      : Boolean(selection.agentKey && item.agentKey === selection.agentKey))
    && (!selection.agentKey || item.agentKey === selection.agentKey));
  const current = matches.length === 1 ? matches[0] : null;
  // The canonical key is server-owned owner_login/name. Labels never confer ownership.
  const owner = Boolean(viewerLogin && selection.agentKey?.split('/').length === 2
    && selection.agentKey.split('/')[0]?.toLowerCase() === viewerLogin.toLowerCase());
  const ownerLabel = owner ? 'Your agent' : current?.ownerLabel ? `${current.ownerLabel}’s agent` : selection.ownerAttribution || 'Room agent';
  const provider = agentInspectorProviderLabel(current?.ideLabel || selection.ideLabel || current?.runtime || 'Agent');
  let signal: InspectorSignal = { state: 'unshared', label: 'Status not shared', detail: 'No current status has been shared with this room.', tone: 'neutral', moving: false };
  if (!sourceFresh || (current?.activityState !== 'offline' && current?.freshness === 'stale')) {
    signal = { state: 'stale', label: 'Updates delayed', detail: 'Waiting for a fresh update from the host.', tone: 'amber', moving: false };
  } else if (current?.activityState === 'offline') {
    signal = { state: 'disconnected', label: 'Offline', detail: 'Shared work is still available.', tone: 'neutral', moving: false };
  } else if (current) {
    if (current.status === 'blocked') signal = {
      state: 'needs_attention', label: 'Needs attention', detail: current.statusText || (owner ? 'Open LetAgents on the host machine to resolve this.' : 'The owner needs to check this agent on its host machine.'), tone: 'red', moving: false,
    };
    else if (current.status === 'working' || current.status === 'reviewing') signal = {
      state: 'responding', label: current.status === 'reviewing' ? 'Reviewing' : 'Working', detail: current.statusText || 'Working in this room.', tone: 'blue', moving: true,
    };
    else signal = { state: 'online', label: 'Online', detail: current.statusText || 'Ready for room work.', tone: 'green', moving: false };
  }
  return { owner, ownerLabel, provider, signal };
}

export function actionProgressMessage(kind: Exclude<AgentInspectorActionIntent["kind"], "recovery_options">): string {
  return ({
    mention: "Opening the room composer…",
    pause: "Pausing this agent…",
    resume: "Resuming this agent…",
    reconnect: "Restoring the existing agent connection…",
    recover: "Restarting the agent app…",
    reconnect_runtime: "Reconnecting the agent and its room messages…",
    restart_runtime: "Restarting the agent app with its saved conversation…",
    fresh_runtime: "Restarting the agent app with a new conversation…",
    stop_turn: "Stopping the current turn…",
    steer_turn: "Applying correction to this session…",
    retry_turn_control: "Retrying the previous stop or correction…",
    resolve_turn_control: "Saving the confirmed result…",
    retry_delivery: "Retrying this delivery…",
    restore_conversation: "Restoring this agent’s conversation…",
    skip_message: "Skipping this blocked message…",
    retire_agent: "Retiring this saved agent…",
    save_settings: "Saving settings…",
    apply_settings: "Restarting with saved settings…",
    move_room: "Moving room…",
    purge_agent: "Deleting history and settings…",
  } as const)[kind];
}

export function actionSuccessMessage(kind: Exclude<AgentInspectorActionIntent["kind"], "recovery_options">): string {
  return ({
    mention: "Composer ready.",
    pause: "Agent paused.",
    resume: "Agent resumed.",
    reconnect: "Reconnection requested.",
    recover: "The agent app is restarting. Its name and project files are kept.",
    reconnect_runtime: "Reconnection requested. Check the agent and room connection status.",
    restart_runtime: "Restart requested with the saved conversation. Wait for the agent to be ready before continuing.",
    fresh_runtime: "A new conversation was requested. Your project files and history are kept. Wait for the agent to be ready before continuing.",
    stop_turn: "Current turn stopped.",
    steer_turn: "Correction applied to the same agent session.",
    retry_turn_control: "Previous stop or correction completed.",
    resolve_turn_control: "Confirmed result saved.",
    retry_delivery: "Delivery retry started.",
    restore_conversation: "Conversation restoration started.",
    skip_message: "Message skipped. Later room work can continue.",
    retire_agent: "Agent retired. Its project files and history are kept.",
    save_settings: "Settings saved.",
    apply_settings: "Restart requested to apply your settings.",
    move_room: "Room move started.",
    purge_agent: "History and settings deleted. Project files are kept.",
  } as const)[kind];
}

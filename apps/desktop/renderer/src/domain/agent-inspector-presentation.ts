import type { DesktopAgentPresence } from '../../../electron/ipc-types';
import type { AgentInspectorSelection } from '../components/desktop/content/desktop-chat-message/types';
import type { AgentInspectorActionIntent, AgentInspectorProjection } from './agent-inspector';
import { agentCompactionProgress } from './managed-agents';

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
  if (kind === "reconnect" && /previous provider runtime is unavailable|no longer has a live runtime/i.test(detail)) {
    return "This provider process has stopped. Recover the agent to continue with the same identity and workspace.";
  }
  if (kind === "recover" && /cannot prove that the previous provider process stopped/i.test(detail)) {
    return "LetAgents could not safely prove the old provider stopped. No replacement was started.";
  }
  if (kind === "recover" && /desktop credentials are required/i.test(detail)) {
    return "LetAgents could not restore this agent’s room credentials. Try recovery again.";
  }
  return detail || "The agent action could not be completed.";
}

export function agentInspectorSignal(projection: AgentInspectorProjection): InspectorSignal {
  if (projection.resourceFreshness === 'stale') return {
    state: 'stale', label: 'Updates delayed', detail: 'Showing the last known state. Controls return when the connection does.', tone: 'amber', moving: false,
  };
  if (agentCompactionProgress(projection.entry)) return {
    state: 'compacting', label: 'Compacting context', detail: 'Summarizing earlier context.', tone: 'violet', moving: true,
  };
  const state = projection.overallState;
  if (projection.deliveryProgress?.phase === 'publishing') return {
    state: 'publishing', label: 'Publishing reply', detail: 'Sending the response to the room.', tone: 'blue', moving: true,
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

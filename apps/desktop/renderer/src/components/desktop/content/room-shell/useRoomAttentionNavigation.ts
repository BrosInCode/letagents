import { watch, type Ref } from "vue";
import type { DesktopSupervisorManifestEntry } from "../../../../../../electron/ipc-types";
import type { AttentionNavigationIntent, RoomTabId } from "./types";

export interface RoomAttentionNavigationOptions {
  intent: () => AttentionNavigationIntent | null | undefined;
  roomIdentifier: () => string;
  roomLoading: () => boolean;
  /** This room's supervised agents have loaded, or are known to be unreadable. */
  agentsSettled: () => boolean;
  agents: () => readonly DesktopSupervisorManifestEntry[];
  activeTab: Ref<RoomTabId>;
  /** Board → Manager → Requests; RoomBoardView clears it once opened. */
  boardGovernanceSection: Ref<"pending" | null>;
  openBoardTask: (taskId: string) => void;
  openThread: (threadRootId: string) => void;
  openEvent: (eventId: string, eventUrl: string | undefined) => void;
  openReasoning: (sessionId: string) => void;
  revealMessage: (messageId: string) => void;
  openAgentDiagnostics: (entry: DesktopSupervisorManifestEntry) => void;
  opened: () => void;
}

/** Opens an Inbox or notification item at the exact place in this room where it can be acted on. */
export function useRoomAttentionNavigation(options: RoomAttentionNavigationOptions): void {
  watch(() => [options.intent(), options.roomLoading(), options.agentsSettled()] as const, ([intent, loading, agentsSettled]) => {
    if (!intent || loading || options.roomIdentifier() !== intent.roomIdentifier) return;
    if (intent.agentEntryId && !agentsSettled) return; // Wait for this room's agents.
    const agent = intent.agentEntryId ? options.agents().find(entry => entry.id === intent.agentEntryId) : undefined;
    if (agent) options.openAgentDiagnostics(agent);
    else if (intent.agentEntryId) options.activeTab.value = "activity"; // Gone or unreadable: show it in Activity.
    else if (intent.boardRequests) { options.boardGovernanceSection.value = "pending"; options.activeTab.value = "board"; }
    else if (intent.approvals) options.activeTab.value = "chat";
    else if (intent.taskId) options.openBoardTask(intent.taskId);
    else if (intent.threadRootId) options.openThread(intent.threadRootId);
    else if (intent.eventId) options.openEvent(intent.eventId, intent.eventUrl);
    else if (intent.reasoningSessionId) options.openReasoning(intent.reasoningSessionId);
    else if (intent.activity) options.activeTab.value = "activity";
    else if (intent.messageId) options.revealMessage(intent.messageId);
    options.opened();
  }, { immediate: true });
}

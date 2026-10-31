import type { KnowledgePage, KnowledgeRecord } from '../../../../shared/room-knowledge.mjs';
import type { DesktopAgentPresence, DesktopBoardIntentSummary, DesktopGitHubEventsPage, DesktopReasoningSession, DesktopRoomThreadInboxPage, DesktopSupervisorManifestEntry, DesktopTaskSummary } from '../ipc-types.js';
export interface DesktopAttentionTask { id: string; title: string; status: string; description: string | null; updated_at: string }
export interface DesktopInboxUpdates {
  threads: DesktopRoomThreadInboxPage;
  tasks: DesktopTaskSummary[];
  githubEvents: DesktopGitHubEventsPage | null;
  reasoningSessions: DesktopReasoningSession[];
  presence: DesktopAgentPresence[];
  unavailable: string[];
  limited: boolean;
}
export interface DesktopAttentionRoom extends KnowledgePage { roomIdentifier: string; displayName: string; tasks: DesktopAttentionTask[]; updates?: DesktopInboxUpdates;
  /** Pending board intents; loaded only where you are a room admin. */
  boardIntents?: DesktopBoardIntentSummary[];
  /** For a focus room, the room it is listed under. The two may carry the same GitHub events. */
  parentRoomIdentifier?: string }
export interface DesktopNeedsYou { rooms: DesktopAttentionRoom[]; failures: Array<{ roomIdentifier: string; displayName: string }>; limited: boolean; cloudUnavailable: boolean; signedOut: boolean;
  /** Supervised agents that are not retired, across rooms, without activity history. */
  agents?: DesktopSupervisorManifestEntry[];
  /** Whether this read loaded each room's `updates`. They are read only while the Inbox is open. */
  updatesIncluded: boolean }
export type { KnowledgeRecord };

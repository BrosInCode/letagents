import type { KnowledgePage, KnowledgeRecord } from '../../../../shared/room-knowledge.mjs';
import type { DesktopAgentPresence, DesktopGitHubEventsPage, DesktopManagedAgentSession, DesktopReasoningSession, DesktopRoomThreadInboxPage, DesktopTaskSummary } from '../ipc-types.js';
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
export interface DesktopAttentionRoom extends KnowledgePage { roomIdentifier: string; displayName: string; tasks: DesktopAttentionTask[]; updates?: DesktopInboxUpdates }
export interface DesktopNeedsYou { rooms: DesktopAttentionRoom[]; failures: Array<{ roomIdentifier: string; displayName: string }>; limited: boolean; cloudUnavailable: boolean; signedOut: boolean; managedSessions?: DesktopManagedAgentSession[]; managedSessionsUnavailable?: boolean }
export type { KnowledgeRecord };

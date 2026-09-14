import type { DesktopInboxUpdates } from '../../ipc-types/knowledge.js';
import { apiFetch } from '../auth.js';
import { getDesktopRoomThreads } from './messages.js';
import { getDesktopGitHubEvents } from './events.js';
import { cloudRoomIdentifierForStorage, listLocalTasks, localRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from './local-store.js';
import { loadPresence, loadSource } from './snapshot/fetch-data.js';
import { mapPresence } from './snapshot/mappers.js';
import { mapDesktopReasoningSessionPayload } from './reasoning/mappers.js';
import { mapDesktopTaskSummaryPayload, type DesktopTaskSummaryPayload } from './tasks/mappers.js';
import type { ReasoningResponse } from './snapshot/payloads.js';

/** Load only inbox sources, without opening rooms, loading transcripts, or draining boards. */
export async function getDesktopInboxUpdates(roomIdentifier: string): Promise<DesktopInboxUpdates> {
  const storage = await resolveLocalAwareRoomStorageMode(roomIdentifier);
  const local = storage.effectiveMode === 'local';
  const id = local ? localRoomIdentifierForStorage(storage, roomIdentifier) : cloudRoomIdentifierForStorage(storage, roomIdentifier);
  const [threads, events, presence, reasoning, tasks] = await Promise.all([
    loadSource(getDesktopRoomThreads(roomIdentifier, 'unread', null, 75), { threads: [], hasMore: false, unreadThreadCount: 0 }),
    loadSource(getDesktopGitHubEvents(roomIdentifier, { limit: 100 }), null),
    local ? loadSource(Promise.resolve({ presence: [] }), { presence: [] }) : loadPresence(id),
    loadSource(local ? Promise.resolve({ sessions: [] } as ReasoningResponse) : apiFetch<ReasoningResponse>(`/rooms/${encodeURIComponent(id)}/reasoning-sessions`), { sessions: [] }),
    local
      ? loadSource(listLocalTasks(id).then(tasks => {
        const completed = tasks.filter(task => ['done', 'merged'].includes(task.status)).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        return { tasks: completed.slice(0, 200), limited: completed.length > 200 };
      }), { tasks: [], limited: false })
      : loadSource(Promise.all(['done', 'merged'].map(status => apiFetch<{ tasks: DesktopTaskSummaryPayload[]; has_more: boolean }>(`/rooms/${encodeURIComponent(id)}/tasks?status=${status}&limit=200&order=recent`))).then(pages => ({
        tasks: pages.flatMap(page => page.tasks.map(mapDesktopTaskSummaryPayload)), limited: pages.some(page => page.has_more),
      })), { tasks: [], limited: false }),
  ]);
  return {
    threads: threads.data, githubEvents: events.data, presence: mapPresence(presence.data),
    reasoningSessions: (reasoning.data.sessions || reasoning.data.reasoning_sessions || []).map(mapDesktopReasoningSessionPayload),
    tasks: tasks.data.tasks,
    unavailable: [['Threads', threads], ['GitHub checks', events], ['Agents', presence], ['Agent sessions', reasoning], ['Completed work', tasks]]
      .flatMap(([label, source]) => typeof source !== 'string' && source.state.status === 'error' ? [String(label)] : []),
    limited: Boolean(events.data?.hasMore) || tasks.data.limited,
  };
}

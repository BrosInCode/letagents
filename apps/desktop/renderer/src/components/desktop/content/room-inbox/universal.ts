import type { DesktopRentalRequest } from '../../../../../../electron/ipc-types.js';
import type { DesktopNeedsYou } from '../../../../../../electron/ipc-types/knowledge.js';
import type { KnowledgeRecord } from '../../../../../../../../shared/room-knowledge.mjs';
import { buildDesktopInboxItems, desktopInboxItemFingerprint, type DesktopInboxItem } from './items';
import { mergeDesktopManagedAgentPresence } from '../../../../domain/managed-agents';

export type InboxSection = 'needs-you' | 'updates' | 'answered';
export interface UniversalInboxItem {
  key: string;
  roomIdentifier: string | null;
  roomName: string;
  section: InboxSection;
  category: string;
  title: string;
  body: string;
  timestamp: string;
  actor: string;
  record?: KnowledgeRecord;
  activity?: DesktopInboxItem;
  taskId?: string;
  fingerprint: string;
}

export function buildUniversalInbox(data: DesktopNeedsYou | null, rentals: DesktopRentalRequest[] = []): UniversalInboxItem[] {
  const result: UniversalInboxItem[] = [];
  for (const room of data?.rooms ?? []) {
    const scope = { roomIdentifier: room.roomIdentifier, roomName: room.displayName };
    for (const record of room.records) result.push({ ...scope, key: JSON.stringify([room.roomIdentifier, record.id]),
      section: record.response ? 'answered' : 'needs-you', category: record.category,
      title: record.title, body: record.body, timestamp: record.response?.at || record.created_at,
      actor: record.author.label, record, fingerprint: String(record.version) });
    const tasks = new Map(room.tasks.map(task => [task.id, { id: task.id, title: task.title, description: task.description, status: task.status, updatedAt: task.updated_at }]));
    for (const task of room.updates?.tasks ?? []) if (!tasks.has(task.id)) tasks.set(task.id, task);
    for (const task of tasks.values()) result.push({ ...scope, key: JSON.stringify([room.roomIdentifier, 'task', task.id]),
      section: 'updates', category: task.status, title: task.title, body: task.description || '',
      timestamp: task.updatedAt || '', actor: 'Task board', taskId: task.id, fingerprint: `${task.status}:${task.updatedAt}` });
    if (!room.updates) continue;
    for (const activity of buildDesktopInboxItems({ filter: 'actionable', threadPage: room.updates.threads, tasks: [],
      githubEvents: room.updates.githubEvents?.events ?? [], reasoningSessions: room.updates.reasoningSessions,
      presence: mergeDesktopManagedAgentPresence(room.updates.presence, data?.managedSessions ?? [], room.roomIdentifier) })) result.push({ ...scope, key: JSON.stringify([room.roomIdentifier, activity.id]),
        section: 'updates', category: activity.kind, title: activity.title, body: activity.preview || '', timestamp: activity.timestamp || '',
        actor: activity.context || 'Room activity', activity, fingerprint: desktopInboxItemFingerprint(activity) });
  }
  for (const activity of buildDesktopInboxItems({ filter: 'actionable', threadPage: null, tasks: [], githubEvents: [], reasoningSessions: [], rentalRequests: rentals })) {
    result.push({ key: JSON.stringify(['account', activity.id]), roomIdentifier: null, roomName: 'Your account', section: 'needs-you',
      category: 'rental_request', title: activity.title, body: activity.kind === 'rental_request' ? activity.request.taskPrompt : '',
      timestamp: activity.timestamp || '', actor: 'Renting', activity, fingerprint: desktopInboxItemFingerprint(activity) });
  }
  return result.sort((a, b) => {
    // Human requests wait oldest-first; updates and answers read newest-first.
    if (a.section !== b.section) return a.section.localeCompare(b.section);
    const order = (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0);
    return (a.section === 'needs-you' ? order : -order) || a.key.localeCompare(b.key);
  });
}

export function inboxCategoryLabel(category: string): string {
  return ({ question: 'Question', decision: 'Decision', approval: 'Approval', review: 'Review', blocked: 'Blocked task',
    in_review: 'Task review', done: 'Completed', merged: 'Merged', thread: 'Unread replies', github_failure: 'Failed check',
    agent_blocked: 'Blocked agent', agent_offline: 'Agent offline', rental_request: 'Rental request' } as Record<string, string>)[category] || category;
}

export function filterUniversalInbox(items: UniversalInboxItem[], section: InboxSection, rooms: string[], dismissals: Record<string, string>): UniversalInboxItem[] {
  return items.filter(item => item.section === section && (!rooms.length || (item.roomIdentifier !== null && rooms.includes(item.roomIdentifier)))
    && (item.section !== 'updates' || dismissals[item.key] !== item.fingerprint));
}

/** Room names are not unique; acknowledge failures by source identity. */
export function inboxSourceFailureKey(data: DesktopNeedsYou | null, rooms: string[], rentalError: string): string {
  return JSON.stringify([
    (data?.failures ?? []).map(room => room.roomIdentifier).sort(),
    (data?.rooms ?? []).filter(room => (!rooms.length || rooms.includes(room.roomIdentifier)) && room.updates?.unavailable.length)
      .map(room => [room.roomIdentifier, [...room.updates!.unavailable].sort()] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
    Boolean(data?.managedSessionsUnavailable), Boolean(data?.cloudUnavailable), rentalError,
  ]);
}

export interface InboxReadChange { key: string; fingerprint: string; previous: string | undefined }

/** Read the exact update versions shown to the user; requests need an explicit answer. */
export function markInboxUpdatesRead(items: UniversalInboxItem[], dismissals: Record<string, string>) {
  const changes: InboxReadChange[] = [];
  const next = { ...dismissals };
  for (const item of items) {
    if (item.section !== 'updates' || next[item.key] === item.fingerprint) continue;
    changes.push({ key: item.key, fingerprint: item.fingerprint, previous: next[item.key] });
    next[item.key] = item.fingerprint;
  }
  return { dismissals: next, changes };
}

export function undoInboxRead(changes: InboxReadChange[], dismissals: Record<string, string>) {
  const next = { ...dismissals };
  for (const change of changes) {
    if (next[change.key] !== change.fingerprint) continue;
    if (change.previous === undefined) delete next[change.key];
    else next[change.key] = change.previous;
  }
  return next;
}

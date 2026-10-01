import type { DesktopRentalRequest } from '../../../../../../electron/ipc-types.js';
import type { DesktopNeedsYou } from '../../../../../../electron/ipc-types/knowledge.js';
import type { KnowledgeRecord } from '../../../../../../../../shared/room-knowledge.mjs';
import { buildDesktopInboxItems, desktopInboxItemFingerprint, type DesktopInboxItem } from './items';
import type { AgentAttentionItem } from './agent-attention';
import type { AttentionNavigationIntent } from '../room-shell/types';
import { mergeDesktopManagedAgentPresence } from '../../../../domain/managed-agents';
import { hostApprovalHeading, hostApprovalSummary } from '../room-chat/host-approval-presentation';
import { readableIntentBody } from '../room-board/governance-presentation';

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
  attention?: AgentAttentionItem;
  taskId?: string;
  fingerprint: string;
}

export function buildUniversalInbox(data: DesktopNeedsYou | null, rentals: DesktopRentalRequest[] = [], attention: readonly AgentAttentionItem[] = []): UniversalInboxItem[] {
  const result: UniversalInboxItem[] = [];
  const roomNames = new Map((data?.rooms ?? []).map(room => [room.roomIdentifier, room.displayName]));
  for (const item of attention) result.push({ key: item.key, roomIdentifier: item.roomIdentifier,
    roomName: roomNames.get(item.roomIdentifier) || item.roomIdentifier, section: 'needs-you', category: item.kind,
    timestamp: item.timestamp, attention: item, fingerprint: item.timestamp, ...agentAttentionText(item) });
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
  return result.sort(compareUniversalInboxItems);
}

/**
 * Agent work stopped on you (tool approvals, stuck agents, waiting board
 * requests) leads Needs you, longest-waiting first. Everything else reads
 * newest-first, so a new request is never buried under old ones.
 */
export function compareUniversalInboxItems(a: UniversalInboxItem, b: UniversalInboxItem): number {
  if (a.section !== b.section) return a.section.localeCompare(b.section);
  const blocking = Number(Boolean(b.attention)) - Number(Boolean(a.attention));
  if (blocking) return blocking;
  const newestFirst = (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0);
  return (a.attention ? -newestFirst : newestFirst) || a.key.localeCompare(b.key);
}

/**
 * Keep the list where the person last saw it. Rows already shown keep their
 * order, and new rows join in the usual order but never at or above the
 * selected row, so an arrival never moves the row being read or clicked.
 * `sorted` is the current list in compareUniversalInboxItems order.
 */
export function stableInboxOrder(shownKeys: readonly string[], sorted: readonly UniversalInboxItem[], selectedKey: string | null): UniversalInboxItem[] {
  const byKey = new Map(sorted.map(item => [item.key, item]));
  const result = shownKeys.flatMap(key => byKey.get(key) ?? []);
  if (!result.length) return [...sorted];
  const shown = new Set(result.map(item => item.key));
  const floor = result.findIndex(item => item.key === selectedKey) + 1;
  for (const item of sorted) {
    if (shown.has(item.key)) continue;
    const before = result.findIndex((other, index) => index >= floor && compareUniversalInboxItems(item, other) < 0);
    result.splice(before < 0 ? result.length : before, 0, item);
  }
  return result;
}

/**
 * The row to select once `key` leaves the list: the one that took its place,
 * else the one before it. `shown` is the list as it was displayed.
 */
export function nextInboxSelection(shown: readonly UniversalInboxItem[], current: readonly UniversalInboxItem[], key: string): UniversalInboxItem | null {
  const present = new Set(current.map(item => item.key));
  const index = shown.findIndex(item => item.key === key);
  if (index < 0) return current[0] ?? null;
  return shown.slice(index + 1).find(item => present.has(item.key) && item.key !== key)
    ?? shown.slice(0, index).reverse().find(item => present.has(item.key))
    ?? current.find(item => item.key !== key) ?? null;
}

function agentAttentionText(item: AgentAttentionItem): Pick<UniversalInboxItem, 'title' | 'body' | 'actor'> {
  if (item.kind === 'tool_approval') return { title: hostApprovalHeading(item.approval), actor: item.approval.presentation.displayName,
    body: hostApprovalSummary(item.approval.presentation) };
  if (item.kind === 'agent_attention') return { title: `${item.agentName} · Needs attention`, body: item.summary, actor: item.agentName };
  const create = item.intent.actionType === 'task_create';
  // Sent to people: the Board Manager's own request, or one no manager answered.
  const waiting = item.intent.escalatedAt ? 'Waiting for a person to decide. As a room admin, you can approve or deny it.'
    : 'Waiting for a Board Manager decision. As a room admin, you can decide it.';
  return { title: create ? 'Create task' : readableIntentBody(item.intent),
    body: `${create ? `${readableIntentBody(item.intent)}\n` : ''}${waiting}`,
    actor: item.intent.proposerActorLabel?.split('|')[0]?.trim() || 'A participant' };
}

/** Where an item opens: its source message, the room, or (by default) the exact place to act. */
export function inboxNavigationIntent(item: UniversalInboxItem, mode?: 'room' | 'source'): AttentionNavigationIntent | null {
  if (!item.roomIdentifier) return null;
  const intent: AttentionNavigationIntent = { roomIdentifier: item.roomIdentifier };
  if (mode === 'source') intent.messageId = item.record?.source_message_id ?? undefined;
  else if (!mode) {
    intent.taskId = item.taskId;
    if (item.activity?.kind === 'thread') intent.threadRootId = item.activity.root.id;
    if (item.activity?.kind === 'github_failure') { intent.eventId = item.activity.event.id; intent.eventUrl = item.activity.url ?? undefined; }
    if (item.activity?.kind === 'agent_blocked') intent.reasoningSessionId = item.activity.session.id;
    if (item.activity?.kind === 'agent_offline') intent.activity = true;
    if (item.attention?.kind === 'agent_attention') intent.agentEntryId = item.attention.entry.id;
    if (item.attention?.kind === 'board_intent') intent.boardRequests = true;
  }
  // An approval card is docked above the room composer.
  if (item.attention?.kind === 'tool_approval' && mode !== 'source') intent.approvals = true;
  return intent;
}

/** Compact age for the queue: "Just now", "5m", "3h", "12d". */
export function inboxRelativeTime(time: string, now = Date.now()): string {
  const at = Date.parse(time);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** Rooms matching a filter search, by name or identifier. */
export function searchInboxRooms<T extends { roomIdentifier: string; displayName: string }>(rooms: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? rooms.filter(room => room.displayName.toLocaleLowerCase().includes(needle) || room.roomIdentifier.toLocaleLowerCase().includes(needle)) : [...rooms];
}

export function inboxCategoryLabel(category: string): string {
  return ({ question: 'Question', decision: 'Decision', approval: 'Approval', review: 'Review', blocked: 'Blocked task',
    in_review: 'Task review', done: 'Completed', merged: 'Merged', thread: 'Unread replies', github_failure: 'Failed check',
    agent_blocked: 'Blocked agent', agent_offline: 'Agent offline', rental_request: 'Rental request',
    tool_approval: 'Tool approval', agent_attention: 'Stuck agent', board_intent: 'Board request' } as Record<string, string>)[category] || category;
}

export function filterUniversalInbox(items: UniversalInboxItem[], section: InboxSection, rooms: string[], dismissals: Record<string, string>): UniversalInboxItem[] {
  return items.filter(item => item.section === section && (!rooms.length || (item.roomIdentifier !== null && rooms.includes(item.roomIdentifier)))
    && (item.section !== 'updates' || dismissals[item.key] !== item.fingerprint));
}

/** Rooms that failed to load, limited to the rooms being viewed. */
export function inboxSourceFailures(data: DesktopNeedsYou | null, rooms: string[]): DesktopNeedsYou['failures'] {
  return (data?.failures ?? []).filter(room => !rooms.length || rooms.includes(room.roomIdentifier));
}

/** Room names are not unique; acknowledge failures by source identity. */
export function inboxSourceFailureKey(data: DesktopNeedsYou | null, rooms: string[], rentalError: string): string {
  return JSON.stringify([
    inboxSourceFailures(data, rooms).map(room => room.roomIdentifier).sort(),
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

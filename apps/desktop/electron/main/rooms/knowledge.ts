import { formatAttentionResponse, createKnowledgeRecord, knowledgeId, reviseKnowledgeRecord, type KnowledgeActor, type KnowledgeInput, type KnowledgePage, type KnowledgeRecord, type KnowledgeRevisionInput, type KnowledgeType } from '../../../../../shared/room-knowledge.mjs';
import { getLocalKnowledge, initializeRoomKnowledge, listLocalKnowledge, localKnowledgeHistory, saveLocalKnowledge } from '../../../../../shared/local-room-knowledge.mjs';
import type { DesktopAttentionRoom, DesktopAttentionTask, DesktopNeedsYou } from '../../ipc-types/knowledge.js';
import { apiFetch, readStoredAuth } from '../auth.js';
import { getLocalChatDatabase } from './local-db.js';
import { cloudRoomIdentifierForStorage, listLocalRoomEntries, listLocalTasks, localRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from './local-store.js';
import { listDesktopAccountRooms } from './account-rooms.js';
import { addLocalChatMessage } from './messages/local-store.js';
import { getDesktopInboxUpdates } from './inbox.js';

async function target(roomIdentifier: string) {
  if (!roomIdentifier?.trim()) throw new Error('Choose a room.');
  const storage = await resolveLocalAwareRoomStorageMode(roomIdentifier);
  return { local: storage.effectiveMode === 'local', id: storage.effectiveMode === 'local'
    ? localRoomIdentifierForStorage(storage, roomIdentifier) : cloudRoomIdentifierForStorage(storage, roomIdentifier) };
}
const path = (id: string, type: KnowledgeType) => {
  if (type !== 'memory' && type !== 'attention') throw new Error('Invalid room knowledge type.');
  return `/rooms/${encodeURIComponent(id)}/${type}`;
};
async function localActor(): Promise<KnowledgeActor> {
  const auth = await readStoredAuth();
  return { id: auth.account?.login ?? 'local-human', label: auth.account?.displayName || auth.account?.login || 'You', kind: 'human' };
}
async function flushResponses(roomId: string) {
  const db = await getLocalChatDatabase(); initializeRoomKnowledge(db);
  const rows = db.prepare('SELECT value FROM local_room_knowledge_outbox WHERE room_id = ?').all(roomId);
  for (const row of rows) {
    const record = JSON.parse(String(row.value)) as KnowledgeRecord;
    await addLocalChatMessage(roomId, { sender: record.response!.actor.label, source: 'browser',
      text: formatAttentionResponse(record),
      reply_to: record.source_message_id || null, idempotency_key: `attention-response:${record.id}` });
    db.prepare('DELETE FROM local_room_knowledge_outbox WHERE room_id = ? AND id = ?').run(roomId, record.id);
  }
}
export async function getDesktopKnowledge(roomIdentifier: string, type: KnowledgeType): Promise<KnowledgePage & { tasks?: DesktopAttentionTask[] }> {
  const room = await target(roomIdentifier);
  if (!room.local) return apiFetch(path(room.id, type));
  if (type === 'attention') await flushResponses(room.id);
  const page = listLocalKnowledge(await getLocalChatDatabase(), room.id, type);
  return { ...page, ...(type === 'attention' ? { tasks: (await listLocalTasks(room.id)).filter(task => ['blocked', 'in_review'].includes(task.status)).map(task => ({ id: task.id, title: task.title, status: task.status, description: task.description ?? null, updated_at: task.updatedAt ?? '' })) } : {}) };
}
export async function createDesktopKnowledge(roomIdentifier: string, type: KnowledgeType, input: KnowledgeInput & { client_id: string }): Promise<KnowledgeRecord> {
  const room = await target(roomIdentifier);
  if (!room.local) return (await apiFetch<{ record: KnowledgeRecord }>(path(room.id, type), { method: 'POST', body: JSON.stringify(input) })).record;
  return saveLocalKnowledge(await getLocalChatDatabase(), createKnowledgeRecord(room.id, type, input, await localActor()));
}
export async function reviseDesktopKnowledge(roomIdentifier: string, type: KnowledgeType, id: string, input: KnowledgeRevisionInput): Promise<KnowledgeRecord> {
  const room = await target(roomIdentifier); knowledgeId(id);
  if (!room.local) return (await apiFetch<{ record: KnowledgeRecord }>(`${path(room.id, type)}/${id}${type === 'attention' ? '/respond' : ''}`, { method: type === 'attention' ? 'POST' : 'PATCH', body: JSON.stringify(input) })).record;
  const db = await getLocalChatDatabase();
  const old = getLocalKnowledge(db, room.id, id);
  if (!old || old.type !== type) throw new Error('Record not found.');
  const actor = await localActor();
  if (type === 'attention' && old.response?.actor.id === actor.id && old.response.body === input.response?.trim() && old.version === input.expected_version + 1) {
    await flushResponses(room.id); return old;
  }
  const record = saveLocalKnowledge(db, reviseKnowledgeRecord(old, input, actor), input.expected_version);
  if (type === 'attention') await flushResponses(room.id);
  return record;
}
export async function getDesktopMemoryHistory(roomIdentifier: string, id: string): Promise<KnowledgePage> {
  const room = await target(roomIdentifier); knowledgeId(id);
  if (!room.local) return apiFetch(`${path(room.id, 'memory')}/${id}/history`);
  const db = await getLocalChatDatabase();
  return { records: localKnowledgeHistory(db, room.id, id), truncated: (getLocalKnowledge(db, room.id, id)?.version ?? 0) > 100 };
}
export async function getDesktopNeedsYou(includeUpdates = false): Promise<DesktopNeedsYou> {
  const auth = await readStoredAuth();
  let cloudUnavailable = false;
  const accountRooms = await listDesktopAccountRooms({ limit: 100 }).catch(async () => {
    cloudUnavailable = true;
    return listLocalRoomEntries({ linkedIdentity: 'cloud' });
  });
  const queue = [...new Map(accountRooms.flatMap(room => [room, ...room.focusRooms]).map(room => [room.roomIdentifier, room])).values()];
  const result: DesktopNeedsYou = { rooms: [], failures: [], cloudUnavailable, limited: accountRooms.length >= 100, signedOut: !auth.token };
  // Bound concurrency; never load full room snapshots just to build an inbox.
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let room = queue.shift(); room; room = queue.shift()) {
      try {
        const [attention, updates] = await Promise.allSettled([
          getDesktopKnowledge(room.roomIdentifier, 'attention'),
          includeUpdates ? getDesktopInboxUpdates(room.roomIdentifier) : Promise.resolve(undefined),
        ]);
        if (attention.status === 'rejected' || updates.status === 'rejected') result.failures.push({ roomIdentifier: room.roomIdentifier, displayName: room.displayName });
        const page = attention.status === 'fulfilled' ? attention.value : { records: [], truncated: false, tasks: [] };
        result.rooms.push({ ...page, tasks: page.tasks ?? [], updates: updates.status === 'fulfilled' ? updates.value : undefined, roomIdentifier: room.roomIdentifier, displayName: room.displayName } satisfies DesktopAttentionRoom);
      } catch { result.failures.push({ roomIdentifier: room.roomIdentifier, displayName: room.displayName }); }
    }
  }));
  return result;
}

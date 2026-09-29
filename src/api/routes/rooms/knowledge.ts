import { isHumanAppWrite } from "../../request/app-session.js";
import type { Express, Response } from 'express';
import type { AuthenticatedRequest } from '../../http/helpers.js';
import type { RoomMessageRouteDeps } from './messages/types.js';
import { resolveParticipantRoom, routeParam } from './messages/helpers.js';
import { requireWorkerRequestAgentIdentity } from '../../request/agent-identity.js';
import { formatAttentionResponse, createKnowledgeRecord, knowledgeId, reviseKnowledgeRecord, RoomKnowledgeError, type KnowledgeActor, type KnowledgeInput, type KnowledgeType } from '../../../../shared/room-knowledge.mjs';
import * as store from '../../db/room-knowledge.js';
import { emitProjectMessage } from '../../server/events.js';
import { getTasksForRooms } from '../../db.js';

export type KnowledgeRouteDeps = Pick<RoomMessageRouteDeps, 'resolveCanonicalRoomRequestId' | 'resolveRoomOrReply' | 'requireParticipant'> & {
  store?: typeof store;
  emitMessage?: typeof emitProjectMessage;
  getTasks?: typeof getTasksForRooms;
};
function fail(res: Response, error: unknown) {
  if (error instanceof RoomKnowledgeError) res.status(error.status).json({ error: error.message });
  else { console.error('[room knowledge]', error); res.status(500).json({ error: 'Unable to save or load room knowledge. Please retry.' }); }
}
function human(req: AuthenticatedRequest): KnowledgeActor | null {
  return req.sessionAccount && (req.authKind === 'session' || isHumanAppWrite(req, req.body ?? {}))
    ? { id: req.sessionAccount.account_id, label: req.sessionAccount.login, kind: 'human' } : null;
}
async function actor(req: AuthenticatedRequest, roomId: string): Promise<KnowledgeActor> {
  const account = human(req);
  if (account) return account;
  const worker = await requireWorkerRequestAgentIdentity({ req, room_id: roomId, body: req.body ?? {} });
  if (!worker.ok) throw new RoomKnowledgeError(worker.error, worker.status);
  return { id: worker.identity.agent_key, label: worker.identity.actor_label, kind: 'agent' };
}
export function registerRoomKnowledgeRoutes(app: Express, deps: KnowledgeRouteDeps) {
  const db = deps.store ?? store;
  const publish = deps.emitMessage ?? emitProjectMessage;
  // Both surfaces have the same room access boundary as messages.
  const room = (req: AuthenticatedRequest, res: Response) => resolveParticipantRoom(req, res, deps as RoomMessageRouteDeps);
  for (const type of ['memory', 'attention'] as KnowledgeType[]) {
    app.get(new RegExp(`^/rooms/(.+)/${type}$`), async (req: AuthenticatedRequest, res) => {
      try {
        const project = await room(req, res); if (!project) return;
        const page = await db.listRoomKnowledge(project.id, type);
        const tasks = type === 'attention' ? (await (deps.getTasks ?? getTasksForRooms)([project.id]))
          .filter(task => task.status === 'blocked' || task.status === 'in_review')
          .map(task => ({ id: task.id, title: task.title, status: task.status, description: task.description, updated_at: task.updated_at })) : undefined;
        res.json({ room_id: project.id, ...page, ...(tasks ? { tasks } : {}) });
      } catch (error) { fail(res, error); }
    });
    app.post(new RegExp(`^/rooms/(.+)/${type}$`), async (req: AuthenticatedRequest, res) => {
      try {
        const project = await room(req, res); if (!project) return;
        const author = await actor(req, project.id);
        const record = createKnowledgeRecord(project.id, type, req.body as KnowledgeInput & { client_id: string }, author);
        await db.assertKnowledgeSource(project.id, record.source_message_id);
        res.status(201).json({ record: await db.createRoomKnowledge(record) });
      } catch (error) { fail(res, error); }
    });
  }
  app.get(/^\/rooms\/(.+)\/memory\/([^/]+)\/history$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res); if (!project) return;
      const id = knowledgeId(routeParam(req, 1));
      const record = await db.getRoomKnowledge(project.id, id);
      if (!record || record.type !== 'memory') { res.status(404).json({ error: 'Memory not found.' }); return; }
      res.json({ records: await db.roomKnowledgeHistory(project.id, id), truncated: record.version > 100 });
    } catch (error) { fail(res, error); }
  });
  for (const type of ['memory', 'attention'] as KnowledgeType[]) {
    const handler = async (req: AuthenticatedRequest, res: Response) => {
      try {
        const project = await room(req, res); if (!project) return;
        const person = human(req);
        if (!person) throw new RoomKnowledgeError('A signed-in human must answer requests or revise room memory.', 403);
        const id = knowledgeId(routeParam(req, 1));
        const old = await db.getRoomKnowledge(project.id, id);
        if (!old || old.type !== type) { res.status(404).json({ error: 'Record not found.' }); return; }
        // Retrying a successful answer after a lost HTTP response is harmless.
        if (type === 'attention' && old.response?.actor.id === person.id && old.response.body === req.body?.response?.trim() && old.version === req.body?.expected_version + 1) {
          res.json({ record: old }); return;
        }
        const next = reviseKnowledgeRecord(old, req.body ?? {}, person);
        await db.assertKnowledgeSource(project.id, next.source_message_id);
        if (type === 'attention') {
          await publish(project.id, person.label, formatAttentionResponse(next), {
            source: 'browser', reply_to: old.source_message_id || null,
            client_message_id: `internal:attention-response:${id}`,
            account_id: person.id,
            with_created_message_in_transaction: tx => db.reviseRoomKnowledgeInTransaction(tx, next, old.version),
          });
          const committed = await db.getRoomKnowledge(project.id, id);
          if (committed?.version !== next.version || committed.response?.body !== next.response?.body || committed.response?.actor.id !== person.id) throw new RoomKnowledgeError('The response could not be committed. Refresh and retry.', 409);
          res.json({ record: committed }); return;
        } else await db.reviseRoomKnowledge(next, old.version);
        res.json({ record: next });
      } catch (error) { fail(res, error); }
    };
    if (type === 'memory') app.patch(/^\/rooms\/(.+)\/memory\/([^/]+)$/, handler);
    else app.post(/^\/rooms\/(.+)\/attention\/([^/]+)\/respond$/, handler);
  }
}

import { isHumanAppWrite } from "../../request/app-session.js";
import type { Express, Response } from 'express';
import type { AuthenticatedRequest } from '../../http/helpers.js';
import type { RoomMessageRouteDeps } from './messages/types.js';
import { resolveParticipantRoom, routeParam } from './messages/helpers.js';
import { requireWorkerRequestAgentIdentity } from '../../request/agent-identity.js';
import { ATTENTION_CLOSED_RESPONSE, createKnowledgeRecord, knowledgeId, reviseKnowledgeRecord, RoomKnowledgeError, type KnowledgeActor, type KnowledgeInput, type KnowledgeType } from '../../../../shared/room-knowledge.mjs';
import { commitAttentionAnswer, commitAttentionRequest, type AttentionRequestPublisher } from '../../rooms/attention-answers.js';
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
async function actor(req: AuthenticatedRequest, roomId: string): Promise<{ author: KnowledgeActor; worker?: AttentionRequestPublisher }> {
  const account = human(req);
  if (account) return { author: account };
  const worker = await requireWorkerRequestAgentIdentity({ req, room_id: roomId, body: req.body ?? {} });
  if (!worker.ok) throw new RoomKnowledgeError(worker.error, worker.status);
  return { author: { id: worker.identity.agent_key, label: worker.identity.actor_label, kind: 'agent' }, worker: worker.identity };
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
        const { author, worker } = await actor(req, project.id);
        const record = createKnowledgeRecord(project.id, type, req.body as KnowledgeInput & { client_id: string }, author);
        await db.assertKnowledgeSource(project.id, record.source_message_id);
        // An agent's request is shown in the room where it asks.
        res.status(201).json({ record: type === 'attention' && worker
          ? await commitAttentionRequest(project.id, record, worker, { store: db, emitMessage: publish })
          : await db.createRoomKnowledge(record) });
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
          res.json({ record: await commitAttentionAnswer(project.id, old, next, person, { store: db, emitMessage: publish }) }); return;
        } else await db.reviseRoomKnowledge(next, old.version);
        res.json({ record: next });
      } catch (error) { fail(res, error); }
    };
    if (type === 'memory') app.patch(/^\/rooms\/(.+)\/memory\/([^/]+)$/, handler);
    else app.post(/^\/rooms\/(.+)\/attention\/([^/]+)\/respond$/, handler);
  }
  // A person closes a request without a decision. The agent that asked is
  // told in the room, as with an answer, and stops waiting on it.
  app.post(/^\/rooms\/(.+)\/attention\/([^/]+)\/close$/, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const project = await room(req, res); if (!project) return;
      const person = human(req);
      if (!person) throw new RoomKnowledgeError('A signed-in human must close requests.', 403);
      const id = knowledgeId(routeParam(req, 1));
      const old = await db.getRoomKnowledge(project.id, id);
      if (!old || old.type !== 'attention') { res.status(404).json({ error: 'Record not found.' }); return; }
      const expected = req.body?.expected_version;
      // Retrying a successful close after a lost HTTP response is harmless.
      if (old.response?.closed && old.response.actor.id === person.id && old.response.body === ATTENTION_CLOSED_RESPONSE && old.version === expected + 1) {
        res.json({ record: old }); return;
      }
      const next = reviseKnowledgeRecord(old, { expected_version: expected, close: true }, person);
      await db.assertKnowledgeSource(project.id, next.source_message_id);
      res.json({ record: await commitAttentionAnswer(project.id, old, next, person, { store: db, emitMessage: publish }) });
    } catch (error) { fail(res, error); }
  });
}

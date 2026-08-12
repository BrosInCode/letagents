import type { Express, Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "../../../db/client.js";
import { messages, room_agent_observation_spans } from "../../../db/schema.js";
import { parseScopedId } from "../../../db/utils.js";
import { queueMessageInfoInvalidation } from "../../../server/message-info-events.js";
import { resolveParticipantRoom } from "../messages/helpers.js";
import { requireWorkerRequestAgentIdentity } from "../../../request/agent-identity.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import type { RoomMessageRouteDeps } from "../messages/types.js";

export function registerAgentObservationRoute(
  app: Express,
  deps: RoomMessageRouteDeps
): void {
  app.put(/^\/rooms\/(.+)\/agents\/self\/observation$/, async (req: AuthenticatedRequest, res: Response) => {
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;

    const workerIdentity = await requireWorkerRequestAgentIdentity({
      req,
      body: req.body || {},
      room_id: project.id,
    });

    if (!workerIdentity.ok) {
      res.status(workerIdentity.status).json({ error: workerIdentity.error });
      return;
    }

    const { identity } = workerIdentity;
    const agentSessionId = identity.agent_session_id;
    if (!agentSessionId) {
      res.status(400).json({ error: "Worker session required" });
      return;
    }

    const { first_message_id, last_message_id } = req.body || {};
    if (!first_message_id || !last_message_id) {
      res.status(400).json({ error: "Missing required observation span parameters" });
      return;
    }

    const firstSeq = parseScopedId(first_message_id, "msg");
    const lastSeq = parseScopedId(last_message_id, "msg");

    if (!firstSeq || !lastSeq) {
      res.status(400).json({ error: "Invalid message IDs for observation span" });
      return;
    }

    // Observation is evidence about messages that exist. A span may never
    // extend past the room's real tail, or future messages would be born
    // "already observed" by whoever claimed the widest range.
    const [roomTail] = await db
      .select({ max_number: sql<number | null>`max(${messages.number})` })
      .from(messages)
      .where(eq(messages.room_id, project.id));
    const maxMessageNumber = roomTail?.max_number ?? 0;
    const spanFirst = Math.min(firstSeq, lastSeq);
    const spanLast = Math.min(Math.max(firstSeq, lastSeq), maxMessageNumber);
    if (spanFirst > spanLast) {
      res.status(400).json({ error: "Observation span names messages that do not exist" });
      return;
    }

    const timestamp = new Date().toISOString();

    const existing = await db
      .select()
      .from(room_agent_observation_spans)
      .where(
        and(
          eq(room_agent_observation_spans.room_id, project.id),
          eq(room_agent_observation_spans.agent_session_id, agentSessionId)
        )
      );

    const plan = planObservationSpanUpdate(existing, spanFirst, spanLast);

    if (plan.kind === "noop") {
      res.json({
        success: true,
        id: plan.spanId,
        first_message_sequence: plan.first,
        last_message_sequence: plan.last,
      });
      return;
    }

    if (plan.kind === "extend") {
      await db
        .update(room_agent_observation_spans)
        .set({
          first_message_sequence: plan.first,
          last_message_sequence: plan.last,
          updated_at: timestamp,
        })
        .where(eq(room_agent_observation_spans.id, plan.spanId));

      queueSpanInvalidation(project.id, spanFirst, spanLast);
      res.json({
        success: true,
        id: plan.spanId,
        first_message_sequence: plan.first,
        last_message_sequence: plan.last,
      });
      return;
    }

    const id = `obs_span_${randomUUID().replace(/-/g, "")}`;
    await db.insert(room_agent_observation_spans).values({
      id,
      room_id: project.id,
      agent_session_id: agentSessionId,
      agent_key: identity.agent_key,
      first_message_sequence: plan.first,
      last_message_sequence: plan.last,
      created_at: timestamp,
      updated_at: timestamp,
    });

    queueSpanInvalidation(project.id, spanFirst, spanLast);
    res.json({
      success: true,
      id,
      first_message_sequence: plan.first,
      last_message_sequence: plan.last,
    });
  });
}

/**
 * An open Message info card showing "not yet observed" must repair as soon as
 * the observation lands. Room-level deliberately: a span window may cover
 * concealed messages whose ids must not be enumerated on the shared stream.
 */
function queueSpanInvalidation(roomId: string, _first: number, _last: number): void {
  queueMessageInfoInvalidation(roomId, null);
}

export type ObservationSpanPlan =
  | { kind: "noop"; spanId: string; first: number; last: number }
  | { kind: "extend"; spanId: string; first: number; last: number }
  | { kind: "insert"; first: number; last: number };

/**
 * Spans may only grow through contiguous evidence. A report separated from
 * every existing span by a gap starts a new span; merging across the gap
 * would fabricate observation of messages the agent never received while it
 * was down. Inputs are normalized so a reversed range cannot bridge one.
 */
export function planObservationSpanUpdate(
  spans: ReadonlyArray<{ id: string; first_message_sequence: number; last_message_sequence: number }>,
  firstSeq: number,
  lastSeq: number,
): ObservationSpanPlan {
  const first = Math.min(firstSeq, lastSeq);
  const last = Math.max(firstSeq, lastSeq);
  for (const span of spans) {
    if (span.first_message_sequence <= first && span.last_message_sequence >= last) {
      return { kind: "noop", spanId: span.id, first: span.first_message_sequence, last: span.last_message_sequence };
    }
  }
  const adjacent = spans.find((span) =>
    first <= span.last_message_sequence + 1 && last >= span.first_message_sequence - 1);
  if (adjacent) {
    return {
      kind: "extend",
      spanId: adjacent.id,
      first: Math.min(adjacent.first_message_sequence, first),
      last: Math.max(adjacent.last_message_sequence, last),
    };
  }
  return { kind: "insert", first, last };
}

import type { Express, Request, Response } from "express";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "../../../db/client.js";
import { message_human_read_ranges, messages } from "../../../db/schema.js";
import { parseScopedId } from "../../../db/utils.js";
import { queueMessageInfoInvalidation } from "../../../server/message-info-events.js";
import { resolveParticipantRoom } from "./helpers.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import type { RoomMessageRouteDeps } from "./types.js";

export function registerMessageReadsRoute(
  app: Express,
  deps: RoomMessageRouteDeps
): void {
  app.put(/^\/rooms\/(.+)\/messages\/read$/, async (req: AuthenticatedRequest, res: Response) => {
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;

    const accountId = req.sessionAccount?.account_id;
    if (!accountId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const items = Array.isArray(req.body?.ranges) ? req.body.ranges : [req.body || {}];
    const timestamp = new Date().toISOString();
    let recordedCount = 0;
    const invalidated: Array<{ first: number; last: number }> = [];

    // Read evidence may only cover messages that exist: a claimed range is
    // clamped to the room's real message numbers, and a thread scope must name
    // a real thread root in this room.
    const [tail] = await db
      .select({ max_number: sql<number | null>`max(${messages.number})` })
      .from(messages)
      .where(eq(messages.room_id, project.id));
    const maxMessageNumber = tail?.max_number ?? 0;
    const verifiedThreadRoots = new Set<number>();

    for (const item of items) {
      const firstMsgId = item.first_message_id ?? (item.first_message_sequence ? `msg_${item.first_message_sequence}` : null);
      const lastMsgId = item.last_message_id ?? (item.last_message_sequence ? `msg_${item.last_message_sequence}` : null);
      const clientBatchId = item.client_batch_id;
      const scopeKind = item.scope_kind === "thread" ? "thread" : "timeline";
      const threadRootId = item.thread_root_id ?? (item.thread_root_number ? `msg_${item.thread_root_number}` : null);

      if (!firstMsgId || !lastMsgId || !clientBatchId) {
        continue;
      }

      const firstSeq = parseScopedId(firstMsgId, "msg");
      const lastSeq = parseScopedId(lastMsgId, "msg");
      const threadRootSeq = threadRootId ? parseScopedId(threadRootId, "msg") : null;

      if (!firstSeq || !lastSeq) {
        continue;
      }
      // A thread-scoped range without its thread root cannot be projected
      // scope-safely; reject it rather than storing unattributable evidence.
      if (scopeKind === "thread" && !threadRootSeq) {
        continue;
      }
      if (threadRootSeq && !verifiedThreadRoots.has(threadRootSeq)) {
        const [root] = await db
          .select({ number: messages.number })
          .from(messages)
          .where(and(eq(messages.room_id, project.id), eq(messages.number, threadRootSeq)))
          .limit(1);
        if (!root) continue;
        verifiedThreadRoots.add(threadRootSeq);
      }

      const rangeFirst = Math.min(firstSeq, lastSeq);
      const rangeLast = Math.min(Math.max(firstSeq, lastSeq), maxMessageNumber);
      if (rangeFirst > rangeLast) {
        continue; // The range only names messages that do not exist yet.
      }

      // Growth bound: an existing earlier-or-equal range that already covers
      // this one is strictly stronger evidence (earliest read times are
      // per-range), so re-reading the same messages stores nothing new.
      const [covering] = await db
        .select({ id: message_human_read_ranges.id })
        .from(message_human_read_ranges)
        .where(
          and(
            eq(message_human_read_ranges.room_id, project.id),
            eq(message_human_read_ranges.account_id, accountId),
            eq(message_human_read_ranges.scope_kind, scopeKind),
            threadRootSeq === null
              ? isNull(message_human_read_ranges.thread_root_number)
              : eq(message_human_read_ranges.thread_root_number, threadRootSeq),
            lte(message_human_read_ranges.first_message_sequence, rangeFirst),
            gte(message_human_read_ranges.last_message_sequence, rangeLast)
          )
        )
        .limit(1);
      if (covering) {
        recordedCount++;
        continue;
      }

      const id = `read_range_${randomUUID().replace(/-/g, "")}`;
      await db
        .insert(message_human_read_ranges)
        .values({
          id,
          room_id: project.id,
          account_id: accountId,
          scope_kind: scopeKind,
          thread_root_number: threadRootSeq,
          first_message_sequence: rangeFirst,
          last_message_sequence: rangeLast,
          client_batch_id: String(clientBatchId).trim(),
          created_at: timestamp,
        })
        .onConflictDoNothing();

      recordedCount++;
      invalidated.push({ first: rangeFirst, last: rangeLast });
    }

    if (recordedCount === 0 && items.length > 0) {
      res.status(400).json({ error: "Missing required read range parameters" });
      return;
    }

    if (invalidated.length > 0) {
      // Room-level: ranges may cover concealed messages whose ids must not
      // be enumerated on the shared room stream.
      queueMessageInfoInvalidation(project.id, null);
    }

    res.json({
      success: true,
      room_id: project.id,
      account_id: accountId,
      recorded_count: recordedCount,
    });
  });
}

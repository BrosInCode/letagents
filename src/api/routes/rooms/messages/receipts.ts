/**
 * Message receipts for the sender: which agents a message woke, who read it,
 * who has not, and why nobody was woken. Only the person who published a
 * message sees its receipts; the route silently omits everyone else's.
 */
import type { Express, Response } from "express";
import { and, asc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";

import { db } from "../../../db/client.js";
import {
  accounts,
  jev_routing_jobs,
  message_agent_receipts,
  message_human_read_ranges,
  messages,
  room_agent_sessions,
  type MessageNoWake,
} from "../../../db/schema.js";
import { visibleMessageCondition } from "../../../db/messages/visibility.js";
import { listRoomMembers } from "../../../db/room-members.js";
import { parseScopedId } from "../../../db/utils.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { getProjectAccessRoomId, resolveProjectRepoAccessTarget } from "../../../rooms/access.js";
import { formatActivationReason } from "./info.js";
import { resolveParticipantRoom } from "./helpers.js";
import type { RoomMessageRouteDeps } from "./types.js";

export const MESSAGE_RECEIPTS_MAX_IDS = 100;

const FINISHED_RECEIPT_STATES = new Set(["replied", "no_reply", "cancelled", "unavailable"]);

export interface MessageReceiptAgent {
  agent_key: string;
  display_name: string;
  provider: string | null;
  owner_name: string | null;
  mine: boolean;
  state: string;
  activation_reason: string;
  activation_reason_label: string;
  reply_message_id: string | null;
  asked_at: string;
  finished_at: string | null;
}

export interface MessageReceiptPerson {
  name: string;
  avatar_url: string | null;
}

export interface MessageReceipt {
  message_id: string;
  sent_at: string;
  agents: MessageReceiptAgent[];
  readers: Array<MessageReceiptPerson & { read_at: string }>;
  not_read: MessageReceiptPerson[] | null;
  no_wake: MessageNoWake | null;
}

/** Parses `ids=msg_1,msg_2`; null when malformed, a number array otherwise. */
export function parseMessageReceiptIds(raw: unknown): number[] | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const numbers = new Set<number>();
  for (const part of raw.split(",")) {
    const number = parseScopedId(part.trim(), "msg");
    if (!number) return null;
    numbers.add(number);
  }
  return [...numbers];
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function personName(row: { name: string | null; login: string | null }): string {
  return row.name || row.login || "Room member";
}

export function registerMessageReceiptsRoute(
  app: Express,
  deps: RoomMessageRouteDeps,
): void {
  app.get(/^\/rooms\/(.+)\/messages\/receipts$/, async (req: AuthenticatedRequest, res: Response) => {
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;

    const rawIds = typeof req.query.ids === "string" ? req.query.ids : "";
    const requested = parseMessageReceiptIds(rawIds);
    if (!requested) {
      res.status(400).json({ error: "ids must be a comma-separated list of message ids such as msg_1,msg_2." });
      return;
    }
    if (requested.length > MESSAGE_RECEIPTS_MAX_IDS) {
      res.status(400).json({
        error: `Ask for at most ${MESSAGE_RECEIPTS_MAX_IDS} messages at a time.`,
        code: "too_many_ids",
      });
      return;
    }

    const requesterId = req.sessionAccount?.account_id ?? null;
    if (!requesterId) {
      res.json({ receipts: [] });
      return;
    }

    try {
      // The same visibility gate as the single-message route, plus the
      // sender rule: anything else is omitted, never refused, so the answer
      // reveals nothing about other people's messages.
      const own = await db
        .select({
          number: messages.number,
          thread_root_number: messages.thread_root_number,
          timestamp: messages.timestamp,
          no_wake: messages.no_wake,
        })
        .from(messages)
        .where(and(
          eq(messages.room_id, project.id),
          inArray(messages.number, requested),
          eq(messages.publisher_account_id, requesterId),
          visibleMessageCondition(deps.shouldIncludePromptOnlyMessages(req)),
        ))
        .orderBy(asc(messages.number));
      if (own.length === 0) {
        res.json({ receipts: [] });
        return;
      }
      const numbers = own.map((row) => row.number);
      const minNumber = numbers[0]!;
      const maxNumber = numbers[numbers.length - 1]!;
      const threadRoots = [...new Set(own.flatMap((row) => row.thread_root_number === null ? [] : [row.thread_root_number]))];
      const hasTimeline = own.some((row) => row.thread_root_number === null);

      const accessRoomId = getProjectAccessRoomId(project);
      const [receipts, replies, readRanges, pendingJobs, members] = await Promise.all([
        db
          .select({
            message_number: message_agent_receipts.message_number,
            agent_key: message_agent_receipts.agent_key,
            agent_session_id: message_agent_receipts.agent_session_id,
            actor_label: message_agent_receipts.actor_label,
            activation_reason: message_agent_receipts.activation_reason,
            receipt_state: message_agent_receipts.receipt_state,
            reply_message_number: message_agent_receipts.reply_message_number,
            created_at: message_agent_receipts.created_at,
            updated_at: message_agent_receipts.updated_at,
            display_name: room_agent_sessions.display_name,
            ide_label: room_agent_sessions.ide_label,
            owner_label: room_agent_sessions.owner_label,
            owner_account_id: room_agent_sessions.owner_account_id,
          })
          .from(message_agent_receipts)
          .leftJoin(room_agent_sessions, and(
            eq(room_agent_sessions.session_id, message_agent_receipts.agent_session_id),
            eq(room_agent_sessions.room_id, message_agent_receipts.room_id),
          ))
          .where(and(
            eq(message_agent_receipts.message_room_id, project.id),
            inArray(message_agent_receipts.message_number, numbers),
          ))
          .orderBy(asc(message_agent_receipts.message_number), asc(message_agent_receipts.created_at), asc(message_agent_receipts.id)),
        db
          .select({
            number: messages.number,
            reply_to_number: messages.reply_to_number,
            publisher_agent_key: messages.publisher_agent_key,
            publisher_agent_session_id: messages.publisher_agent_session_id,
          })
          .from(messages)
          .where(and(eq(messages.room_id, project.id), inArray(messages.reply_to_number, numbers)))
          .orderBy(asc(messages.number)),
        db
          .select({
            account_id: message_human_read_ranges.account_id,
            scope_kind: message_human_read_ranges.scope_kind,
            thread_root_number: message_human_read_ranges.thread_root_number,
            first: message_human_read_ranges.first_message_sequence,
            last: message_human_read_ranges.last_message_sequence,
            created_at: message_human_read_ranges.created_at,
            login: accounts.login,
            name: accounts.display_name,
            avatar_url: accounts.avatar_url,
          })
          .from(message_human_read_ranges)
          .leftJoin(accounts, eq(message_human_read_ranges.account_id, accounts.id))
          .where(and(
            eq(message_human_read_ranges.room_id, project.id),
            lte(message_human_read_ranges.first_message_sequence, maxNumber),
            gte(message_human_read_ranges.last_message_sequence, minNumber),
            or(
              hasTimeline ? eq(message_human_read_ranges.scope_kind, "timeline") : sql`FALSE`,
              threadRoots.length > 0
                ? and(
                  eq(message_human_read_ranges.scope_kind, "thread"),
                  inArray(message_human_read_ranges.thread_root_number, threadRoots),
                )
                : sql`FALSE`,
            ),
          )),
        db
          .select({ message_number: jev_routing_jobs.message_number })
          .from(jev_routing_jobs)
          .where(and(
            eq(jev_routing_jobs.room_id, project.id),
            inArray(jev_routing_jobs.message_number, numbers),
            sql`${jev_routing_jobs.state} <> 'completed'`,
          )),
        // A GitHub-managed room has no member list: the repository decides.
        resolveProjectRepoAccessTarget(project).then((target) => target ? null : listRoomMembers(accessRoomId)),
      ]);

      const repliesByMessage = new Map<number, { byAgentKey: Map<string, number>; bySession: Map<string, number> }>();
      for (const reply of replies) {
        if (reply.reply_to_number === null) continue;
        const entry = repliesByMessage.get(reply.reply_to_number) ?? { byAgentKey: new Map(), bySession: new Map() };
        if (reply.publisher_agent_key && !entry.byAgentKey.has(reply.publisher_agent_key)) {
          entry.byAgentKey.set(reply.publisher_agent_key, reply.number);
        }
        if (reply.publisher_agent_session_id && !entry.bySession.has(reply.publisher_agent_session_id)) {
          entry.bySession.set(reply.publisher_agent_session_id, reply.number);
        }
        repliesByMessage.set(reply.reply_to_number, entry);
      }

      const agentsByMessage = new Map<number, MessageReceiptAgent[]>();
      for (const receipt of receipts) {
        const replyNumber = receipt.reply_message_number
          ?? repliesByMessage.get(receipt.message_number)?.byAgentKey.get(receipt.agent_key)
          ?? repliesByMessage.get(receipt.message_number)?.bySession.get(receipt.agent_session_id)
          ?? null;
        const list = agentsByMessage.get(receipt.message_number) ?? [];
        list.push({
          agent_key: receipt.agent_key,
          display_name: receipt.display_name || receipt.actor_label,
          provider: receipt.ide_label ?? null,
          owner_name: receipt.owner_label ?? null,
          mine: receipt.owner_account_id === requesterId,
          state: receipt.receipt_state,
          activation_reason: receipt.activation_reason,
          activation_reason_label: formatActivationReason(receipt.activation_reason),
          reply_message_id: replyNumber === null ? null : `msg_${replyNumber}`,
          asked_at: iso(receipt.created_at),
          finished_at: FINISHED_RECEIPT_STATES.has(receipt.receipt_state) ? iso(receipt.updated_at) : null,
        });
        agentsByMessage.set(receipt.message_number, list);
      }

      const pending = new Set(pendingJobs.map((job) => job.message_number));
      const result: MessageReceipt[] = own.map((row) => {
        // Ranges are scope-safe: a timeline range never marks a thread reply
        // read, and a thread range covers only its own thread.
        const readers = new Map<string, MessageReceiptPerson & { read_at: string }>();
        for (const range of readRanges) {
          if (range.account_id === requesterId) continue;
          if (range.first > row.number || range.last < row.number) continue;
          const inScope = row.thread_root_number === null
            ? range.scope_kind === "timeline"
            : range.scope_kind === "thread" && range.thread_root_number === row.thread_root_number;
          if (!inScope) continue;
          const readAt = iso(range.created_at);
          const existing = readers.get(range.account_id);
          if (!existing || readAt < existing.read_at) {
            readers.set(range.account_id, { name: personName(range), avatar_url: range.avatar_url ?? null, read_at: readAt });
          }
        }
        const agents = agentsByMessage.get(row.number) ?? [];
        const noWake = agents.length > 0 || pending.has(row.number)
          ? null
          : row.no_wake ?? { reason: "unknown" as const };
        return {
          message_id: `msg_${row.number}`,
          sent_at: iso(row.timestamp),
          agents,
          readers: [...readers.values()].sort((a, b) => a.read_at.localeCompare(b.read_at)),
          not_read: members === null
            ? null
            : members
              .filter((member) => member.account_id !== requesterId && !readers.has(member.account_id))
              .map((member) => ({ name: personName({ name: member.display_name, login: member.login }), avatar_url: member.avatar_url ?? null })),
          no_wake: noWake,
        };
      });
      res.json({ receipts: result });
    } catch (error) {
      console.error("[message receipts]", error);
      res.status(500).json({ error: "Message receipts could not be loaded. Please retry." });
    }
  });
}

/**
 * Ordering and batching rules for room deliveries queued behind an agent's
 * FIFO head. These helpers only classify and build payloads; the inbox store
 * applies them inside its own transactions and never moves or settles the head.
 */

/**
 * - person: a signed-in person's room message.
 * - notice: a LetAgents system or wake-rule message (board and task notices).
 * - automated: any other room message, including other agents'.
 * - fixed: a daemon-authored row (initial message, correction, task continuation).
 */
export type QueuedDeliveryKind = "person" | "notice" | "automated" | "fixed";

/** A queued notice delivered in the same provider turn as the activating notice. */
export type QueuedNotice = {
  id: string;
  sent_at: string | null;
  text: string;
  /** A newer firing of the same wake rule about the same task or pull request, in this turn. */
  superseded_by: string | null;
};
export type QueuedNotices = {
  instruction: string;
  /** Set when a newer firing of the activating notice's own wake rule is in this turn. */
  activating_superseded_by: string | null;
  notices: QueuedNotice[];
};
type NoticeRow = { source_message_id: string; source_message: unknown };

const ROOM_MESSAGE_ID = /^(?:msg_)?(\d+)$/;
/** At most this many queued notices ride in one turn; the rest wait for the next notice turn. */
export const MAX_QUEUED_NOTICES_PER_TURN = 16;
const MAX_QUEUED_NOTICE_TEXT = 1_200;
/** An automated delivery is overtaken by at most this many later people's messages. */
export const MAX_PERSON_PASSES = 5;
export const QUEUED_NOTICES_INSTRUCTION = "Other notices for you were queued behind the activating message. They are "
  + "delivered in this same turn, oldest first, instead of one turn each, and need no separate reply. superseded_by marks a "
  + "notice followed by a newer firing of the same wake rule about the same task or pull request; act on the newer one. "
  + "Check the current board, task and pull request state, then handle the activating message and each notice that still applies.";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function queuedDeliveryKind(sourceMessageId: string, sourceMessage: unknown): QueuedDeliveryKind {
  if (!ROOM_MESSAGE_ID.test(sourceMessageId)) return "fixed";
  const message = record(sourceMessage);
  if (!message) return "automated";
  // The server sets `source` and `agent_identity`; a sender name is display text.
  const agentAuthored = record(message.agent_identity) !== null
    || (typeof message.publisher_agent_key === "string" && message.publisher_agent_key.trim() !== "");
  if (agentAuthored) return "automated";
  const source = lower(message.source);
  if (source === "browser") return "person";
  if ((source === "system" || source === "wake_rule") && lower(message.sender) === "letagents") return "notice";
  return "automated";
}

/** Room arrival order of a room message id; callers only pass ids `queuedDeliveryKind` did not mark fixed. */
export function roomArrival(sourceMessageId: string): bigint {
  return BigInt(ROOM_MESSAGE_ID.exec(sourceMessageId)?.[1] ?? "0");
}

/**
 * The wake rule and the task or pull request a wake-rule notice reports on,
 * read from the server-formatted notice. GitHub-supplied names cannot end a
 * line with a PR number or forge the task detail line, so a mismatch only
 * drops the hint.
 */
export function wakeNoticeSubject(sourceMessage: unknown): { rule: string; subject: string } | null {
  const message = record(sourceMessage);
  if (!message || lower(message.source) !== "wake_rule" || typeof message.text !== "string") return null;
  const [first = "", ...details] = message.text.split("\n");
  const fired = /^Your wake rule (\S+) fired: (.+)\.$/.exec(first);
  if (!fired) return null;
  const [, rule, occurrence] = fired as unknown as [string, string, string];
  const pr = /^#(\d+) was (?:merged|closed)$/.exec(occurrence)
    ?? /(?:^|\s)(?:approved|requested changes on|reviewed) #(\d+)$/.exec(occurrence);
  if (pr) return { rule, subject: `#${pr[1]}` };
  const task = /^(task_[A-Za-z0-9_-]+) moved to /.exec(occurrence)?.[1];
  return task && details.some((line) => line.startsWith(`- ${task}: `) && line.includes(" → ")) ? { rule, subject: task } : null;
}

function sameWakeSubject(left: unknown, right: unknown): boolean {
  const a = wakeNoticeSubject(left); const b = wakeNoticeSubject(right);
  return Boolean(a && b && a.rule === b.rule && a.subject === b.subject);
}

/** The payload a claimed notice carries for the notices queued behind it, oldest first. */
export function queuedNoticesFor(activating: NoticeRow, queued: readonly NoticeRow[]): QueuedNotices {
  const newerSame = (row: NoticeRow, index: number) =>
    queued.slice(index + 1).filter((later) => sameWakeSubject(row.source_message, later.source_message)).at(-1)?.source_message_id ?? null;
  return {
    instruction: QUEUED_NOTICES_INSTRUCTION,
    activating_superseded_by: newerSame(activating, -1),
    notices: queued.map((row, index) => {
      const message = record(row.source_message) ?? {};
      const text = typeof message.text === "string" ? message.text : "";
      return {
        id: row.source_message_id,
        sent_at: typeof message.timestamp === "string" ? message.timestamp : null,
        text: text.length > MAX_QUEUED_NOTICE_TEXT
          ? `${text.slice(0, MAX_QUEUED_NOTICE_TEXT)}… (truncated; read ${row.source_message_id} in the room)` : text,
        superseded_by: newerSame(row, index),
      };
    }),
  };
}

/** Ids a claimed notice recorded; anything malformed is ignored. */
export function queuedNoticeIds(activation: Record<string, unknown>): string[] {
  const notices = record(activation.queued_notices)?.notices;
  return Array.isArray(notices) ? notices.flatMap((entry) => typeof record(entry)?.id === "string" ? [String(record(entry)!.id)] : []) : [];
}

/** Why a queued notice settles without its own turn once the activating turn has started. */
export function queuedNoticeReason(activation: Record<string, unknown>, activatingId: string, noticeId: string): string {
  const notices = record(activation.queued_notices)?.notices;
  const entry = Array.isArray(notices) ? notices.map(record).find((candidate) => candidate?.id === noticeId) : null;
  return typeof entry?.superseded_by === "string"
    ? `Superseded by ${entry.superseded_by}, a newer firing of the same wake rule. Both were delivered in the turn for ${activatingId}, so this notice had no separate turn.`
    : `Delivered in the turn for ${activatingId} together with other queued notices, so this notice had no separate turn.`;
}

/**
 * People's messages go ahead of earlier automated deliveries, FIFO among
 * people. `passes` is how many people already went ahead of a delivery,
 * durably recorded by the caller; a delivery passed `maxPasses` times is not
 * passed again, so a busy room cannot starve it. Returns the new order and,
 * for each moved person, the deliveries it went ahead of.
 */
export function peopleFirstOrder<T extends { kind: QueuedDeliveryKind; arrival: bigint; passes: number }>(run: readonly T[],
  maxPasses = MAX_PERSON_PASSES): { order: T[]; passed: Map<T, T[]> } {
  const order = [...run];
  const passes = new Map<T, number>(order.map((entry) => [entry, entry.passes]));
  const passed = new Map<T, T[]>();
  for (let index = 0; index < order.length; index += 1) {
    const entry = order[index]!;
    if (entry.kind !== "person") continue;
    let to = index;
    while (to > 0 && order[to - 1]!.kind !== "person" && order[to - 1]!.arrival < entry.arrival
      && passes.get(order[to - 1]!)! < maxPasses) to -= 1;
    if (to === index) continue;
    const overtaken = order.slice(to, index);
    for (const other of overtaken) passes.set(other, passes.get(other)! + 1);
    order.splice(index, 1);
    order.splice(to, 0, entry);
    passed.set(entry, overtaken);
  }
  return { order, passed };
}

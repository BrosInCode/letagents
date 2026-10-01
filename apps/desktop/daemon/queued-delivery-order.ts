/**
 * Ordering and coalescing rules for room deliveries still queued behind an
 * agent's FIFO head. These helpers only classify and build payloads; the inbox
 * store applies them inside its ingestion transaction and never to the head.
 */

/**
 * - person: a signed-in person's room message.
 * - notice: a LetAgents system or wake-rule message (board and task notices).
 * - automated: any other room message, including other agents'.
 * - fixed: a daemon-authored row (initial message, correction, task continuation).
 */
export type QueuedDeliveryKind = "person" | "notice" | "automated" | "fixed";

/** One earlier notice delivered together with a newer one. */
export type EarlierNotice = {
  id: string;
  sent_at: string | null;
  text: string;
  /** The task or pull request a wake-rule notice reports on, when known. */
  subject: string | null;
  /** A newer notice in this delivery about the same subject. */
  superseded_by: string | null;
};
export type EarlierNotices = { instruction: string; notices: EarlierNotice[]; omitted_count: number };
export type FoldableNotice = { source_message_id: string; source_message: unknown; activation: Record<string, unknown> };

const ROOM_MESSAGE_ID = /^(?:msg_)?\d+$/;
export const MAX_EARLIER_NOTICES = 16;
const MAX_EARLIER_NOTICE_TEXT = 1_200;
export const EARLIER_NOTICES_INSTRUCTION = "These earlier notices for you arrived while you were busy. They are delivered "
  + "together with this message, oldest first, instead of one turn each. Some may describe state that has since changed; "
  + "superseded_by names a newer notice about the same task or pull request. Check the current board, task and pull "
  + "request state, then handle each notice that still applies. If omitted_count is above zero, that many older notices "
  + "were left out to keep this delivery bounded; read the room if you need them.";

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

/**
 * The task or pull request a wake-rule notice reports on, read from the
 * server-formatted notice. GitHub-supplied names cannot end a line with a PR
 * number or forge the task detail line, so a mismatch only drops the hint.
 */
export function wakeNoticeSubject(sourceMessage: unknown): string | null {
  const message = record(sourceMessage);
  if (!message || lower(message.source) !== "wake_rule" || typeof message.text !== "string") return null;
  const [first = "", ...details] = message.text.split("\n");
  const occurrence = /^Your wake rule \S+ fired: (.+)\.$/.exec(first)?.[1];
  if (!occurrence) return null;
  const pr = /^#(\d+) was (?:merged|closed)$/.exec(occurrence)
    ?? /(?:^|\s)(?:approved|requested changes on|reviewed) #(\d+)$/.exec(occurrence);
  if (pr) return `#${pr[1]}`;
  const task = /^(task_[A-Za-z0-9_-]+) moved to /.exec(occurrence)?.[1];
  return task && details.some((line) => line.startsWith(`- ${task}: `) && line.includes(" → ")) ? task : null;
}

function earlierNotice(item: FoldableNotice): EarlierNotice {
  const message = record(item.source_message) ?? {};
  const text = typeof message.text === "string" ? message.text : "";
  return {
    id: item.source_message_id,
    sent_at: typeof message.timestamp === "string" ? message.timestamp : null,
    text: text.length > MAX_EARLIER_NOTICE_TEXT ? `${text.slice(0, MAX_EARLIER_NOTICE_TEXT - 1)}…` : text,
    subject: wakeNoticeSubject(item.source_message),
    superseded_by: null,
  };
}

/** Notices an earlier fold already attached to this row; anything malformed is dropped. */
function carriedNotices(activation: Record<string, unknown>): { notices: EarlierNotice[]; omitted: number } {
  const carried = record(activation.earlier_notices);
  if (!carried) return { notices: [], omitted: 0 };
  const notices = Array.isArray(carried.notices) ? carried.notices.flatMap((value): EarlierNotice[] => {
    const entry = record(value);
    if (!entry || typeof entry.id !== "string" || typeof entry.text !== "string") return [];
    return [{
      id: entry.id,
      sent_at: typeof entry.sent_at === "string" ? entry.sent_at : null,
      text: entry.text.slice(0, MAX_EARLIER_NOTICE_TEXT),
      subject: typeof entry.subject === "string" ? entry.subject : null,
      superseded_by: null,
    }];
  }) : [];
  const omitted = Number.isSafeInteger(carried.omitted_count) && Number(carried.omitted_count) > 0 ? Number(carried.omitted_count) : 0;
  return { notices, omitted };
}

/**
 * Fold older queued notices into the newest one. Returns the payload for the
 * newest notice's activation and, for every folded row, why it gets no turn.
 */
export function foldEarlierNotices(folded: readonly FoldableNotice[], target: Pick<FoldableNotice, "source_message_id" | "source_message">): {
  earlier: EarlierNotices;
  reasons: Map<string, string>;
} {
  let notices: EarlierNotice[] = [];
  let omitted = 0;
  for (const item of folded) {
    const carried = carriedNotices(item.activation);
    notices.push(...carried.notices, earlierNotice(item));
    omitted += carried.omitted;
  }
  if (notices.length > MAX_EARLIER_NOTICES) {
    omitted += notices.length - MAX_EARLIER_NOTICES;
    notices = notices.slice(-MAX_EARLIER_NOTICES);
  }
  const targetSubject = wakeNoticeSubject(target.source_message);
  notices.forEach((notice, index) => {
    if (!notice.subject) return;
    const later = [...notices.slice(index + 1), { id: target.source_message_id, subject: targetSubject }]
      .filter((candidate) => candidate.subject === notice.subject).at(-1);
    notice.superseded_by = later?.id ?? null;
  });
  const reasons = new Map<string, string>();
  for (const item of folded) {
    const entry = notices.find((notice) => notice.id === item.source_message_id);
    reasons.set(item.source_message_id, !entry
      ? `Folded into ${target.source_message_id} without its text because more than ${MAX_EARLIER_NOTICES} notices were queued; it remains in the room history. No separate turn ran.`
      : entry.superseded_by
        ? `Superseded by ${entry.superseded_by}, a newer notice about ${entry.subject}. Delivered with ${target.source_message_id} instead of a separate turn.`
        : `Delivered together with ${target.source_message_id}, a newer notice, instead of a separate turn.`);
  }
  return { earlier: { instruction: EARLIER_NOTICES_INSTRUCTION, notices, omitted_count: omitted }, reasons };
}

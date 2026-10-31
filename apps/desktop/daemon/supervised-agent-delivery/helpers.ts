import { queuedDeliveryKind } from "../queued-delivery-order.js";
import type { InboxActivation, IngressMessage, SupervisedInboxItem } from "../supervised-agent-inbox-store.js";
import { redactCredentialText } from "../credential-redaction.js";
import { POLL_ERROR_BACKOFF_BASE_MS, POLL_ERROR_BACKOFF_CAP_MS } from "./constants.js";

export function providerFailureDisplayText(message: string): string {
  const normalized = message
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\t\n\r ]+/g, " ")
    .trim();
  return redactCredentialText(normalized, 1_024).value;
}

export type SupervisedReplyTarget = {
  replyTo: string | null;
  threadRootId: string | null;
};

/**
 * Supervised replies inherit only real thread membership. Current room rows
 * identify top-level quote replies with thread_root_id equal to their own id;
 * carrying quote-only reply_to metadata forward would incorrectly pull the
 * provider response into a thread.
 */
export function supervisedReplyTargetForSourceMessage(sourceMessage: unknown): SupervisedReplyTarget {
  if (!sourceMessage || typeof sourceMessage !== "object" || Array.isArray(sourceMessage)) {
    return { replyTo: null, threadRootId: null };
  }
  const source = sourceMessage as Record<string, unknown>;
  const sourceId = stringOrNull(source.id);
  const thread = source.thread && typeof source.thread === "object" && !Array.isArray(source.thread)
    ? source.thread as Record<string, unknown>
    : null;
  const threadRootId = stringOrNull(source.thread_root_id)
    ?? stringOrNull(source.threadRootId)
    ?? stringOrNull(thread?.root_message_id);
  const isThreadReply = threadRootId !== null
    && sourceId !== null
    && threadRootId !== sourceId
    && (thread?.is_thread_reply !== false);
  return isThreadReply
    ? { replyTo: sourceId, threadRootId }
    : { replyTo: null, threadRootId: null };
}

export class AuthorityLostError extends Error {
  constructor() {
    super("Supervised delivery authority changed before the provider turn became durable.");
  }
}

export function activatedMessages(messages: readonly Record<string, unknown>[]): IngressMessage[] {
  return messages.flatMap((message) => {
    const activation = message.activation;
    const current = activation && typeof activation === "object" && !Array.isArray(activation)
      ? (activation as Record<string, unknown>).for_current_agent
      : null;
    const id = stringOrNull(message.id);
    // This is the server's routing decision. Do not infer activation from
    // mention-looking text and do not enqueue `silent`/`unaddressed`/unknown
    // decisions: they are observed solely by cursor progress.
    if (!id || !current || typeof current !== "object" || Array.isArray(current)
      || (current as Record<string, unknown>).decision !== "activate") return [];
    return [{ source_message_id: id, source_message: message, activation: current as InboxActivation }];
  });
}

export function observedMessages(messages: readonly Record<string, unknown>[]) {
  return messages.flatMap((message) => {
    const id = stringOrNull(message.id);
    if (!id) return [];
    const activation = message.activation;
    const current = activation && typeof activation === "object" && !Array.isArray(activation)
      ? (activation as Record<string, unknown>).for_current_agent
      : null;
    const normalized = current && typeof current === "object" && !Array.isArray(current)
      ? current as InboxActivation
      : {};
    const decision = typeof normalized.decision === "string" ? normalized.decision : "unknown";
    return [{ source_message_id: id, source_message: message, activation: normalized, activation_decision: decision }];
  });
}

function stringOrNull(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }

export function lastMessageId(messages: readonly Record<string, unknown>[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const id = stringOrNull(messages[index]?.id);
    if (id) return id;
  }
  return null;
}

export function orderedHumanSpeakingTurn(item: SupervisedInboxItem): boolean {
  const message = item.source_message as Record<string, unknown> | null;
  const turn = item.activation.turn as Record<string, unknown> | null;
  return queuedDeliveryKind(item.source_message_id, item.source_message) === "person"
    && message?.id === item.source_message_id && item.activation.decision === "activate"
    && Boolean(turn && typeof turn === "object" && !Array.isArray(turn)
      && Number.isSafeInteger(turn.count) && Number(turn.count) > 1
      && Number.isSafeInteger(turn.position) && Number(turn.position) >= 1 && Number(turn.position) <= Number(turn.count));
}

export function persistedAcceptedTerminal(outcome: string | null):
  | { kind: "reply"; text: string }
  | { kind: "no_reply"; text: null }
  | null {
  if (!outcome) return null;
  try {
    const parsed = JSON.parse(outcome) as { kind?: unknown; text?: unknown };
    if (parsed.kind === "reply" && typeof parsed.text === "string" && parsed.text.trim()) {
      return { kind: "reply", text: parsed.text };
    }
    return parsed.kind === "no_reply" && (parsed.text === null || parsed.text === undefined)
      ? { kind: "no_reply", text: null }
      : null;
  } catch { return null; }
}

export function pollErrorBackoffMs(consecutiveErrors: number): number {
  const exponent = Math.max(0, Math.min(30, consecutiveErrors - 1));
  return Math.min(POLL_ERROR_BACKOFF_CAP_MS, POLL_ERROR_BACKOFF_BASE_MS * (2 ** exponent));
}

/** What the owner reads when Try now was saved, and the agent changed before its attempt could start. */
export const AGENT_CHANGED_BEFORE_TRY_NOW = "The agent changed before it could try again. Refresh and check again.";

/** The follow-up with this id that waits for its time, when nothing has started for it. */
export function scheduledFollowUp<Receipt extends Pick<SupervisedInboxItem, "source_message_id" | "state" | "next_attempt_at_ms" | "provider_turn_id" | "outcome">>(
  receipts: readonly Receipt[], sourceMessageId: string): Receipt | null {
  return receipts.find((receipt) => receipt.source_message_id === sourceMessageId && sourceMessageId.startsWith("task-continuation:")
    && receipt.state === "pending" && receipt.next_attempt_at_ms !== null && !receipt.provider_turn_id && !receipt.outcome) ?? null;
}

/** What the owner reads when Try now or Stop trying comes too late: the automatic attempt is no longer waiting. */
export function noLongerAvailable(sourceMessageId: string, otherwise: string): string {
  return sourceMessageId.startsWith("task-continuation:") ? "This automatic attempt has already started or ended." : otherwise;
}

/** An abortable delay that releases its signal listener on either completion path. */
export function abortablePollDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
    // An abort between the first check and listener registration is still
    // observed, and uses the same cleanup path as a completed timer.
    if (signal.aborted) finish();
  });
}

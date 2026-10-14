import type { DesktopTaskSummary } from "../../ipc-types.js";
import type { ProviderRoomTurnRequest } from "./provider-adapter.js";
import { ROOM_EXPRESSION_GUIDANCE } from "../../../../../shared/room-expressions.mjs";
import { isDeepStrictEqual } from "node:util";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isRoomMessage(value: Record<string, unknown>): boolean {
  return typeof value.id === "string" && /^msg_[1-9]\d*$/.test(value.id) && typeof value.text === "string";
}

/** Preserve conversation content and unknown fields; omit only known UI summaries. */
function conversationMessage(message: unknown): unknown {
  const value = record(message);
  if (!value) return message;
  const { activation: _activation, ...context } = value;
  if (!isRoomMessage(context)) return context;
  if (context.display_text === context.text) delete context.display_text;
  const profile = record(context.sender_profile);
  if (profile) {
    const { avatar_url: _avatar, ...identity } = profile;
    context.sender_profile = identity;
  }
  const thread = record(context.thread);
  if (thread) {
    const { reply_count: _count, unread_count: _unread, has_unread: _hasUnread,
      participants: _participants, participant_count: _participantsCount,
      participants_truncated: _truncated, last_read_message_id: _lastRead, ...reference } = thread;
    context.thread = reference;
  }
  return context;
}

/** Routing guidance belongs to this turn, not to every historical message.
 * This compacts one prompt, never assumes that an earlier turn retained context.
 */
export function formatRoomTurnContext(request: Pick<ProviderRoomTurnRequest, "observedContext" | "sourceMessage" | "activation">): string[] {
  const source = conversationMessage(request.sourceMessage);
  const sourceRecord = record(source);
  const context = (request.observedContext ?? []).map(conversationMessage).filter(message =>
    !sourceRecord || !isRoomMessage(sourceRecord) || !isDeepStrictEqual(message, source));
  const supplied = [...context, source].map(record).filter((value): value is Record<string, unknown> => value !== null && isRoomMessage(value));
  const reference = (value: unknown): unknown => {
    const quote = record(conversationMessage(value));
    if (!quote || !isRoomMessage(quote)) return value;
    // A reference may contain fewer fields than a full message. Do not erase
    // a different edit, author, GIF, attachment or other substantive field.
    const candidates = supplied.filter(message => message.id === quote.id);
    if (candidates.length && candidates.every(message => Object.entries(quote).every(([key, field]) =>
      isDeepStrictEqual(field, message[key])))) return { id: quote.id };
    supplied.push(quote); // Keep an outside-history quote in full once.
    return quote;
  };
  const compact = (value: unknown): unknown => {
    const message = record(value);
    if (!message || !isRoomMessage(message)) return value;
    const thread = record(message.thread);
    return {
      ...message,
      ...(message.reply_to === undefined ? {} : { reply_to: reference(message.reply_to) }),
      ...(thread?.latest_reply === undefined ? {} : { thread: { ...thread, latest_reply: reference(thread.latest_reply) } }),
    };
  };
  return [
    `Recent bounded room context: ${JSON.stringify(context.map(compact))}`,
    `Source message: ${JSON.stringify(compact(source))}`,
    `Activation: ${JSON.stringify(request.activation)}`,
  ];
}

/** Optional optimization for a continuously observed native conversation.
 * Keep only the previous bounded window; never persist this across reconnects.
 */
export class RoomTurnContextCache {
  private scope = "";
  private revision = 0;
  private messages = new Map<string, unknown>();

  reset(): void {
    this.scope = "";
    this.messages.clear();
    this.revision++;
  }

  prepare(request: ProviderRoomTurnRequest, continuationId: string): { lines: string[]; commit: () => void } {
    const source = record(conversationMessage(request.sourceMessage));
    const roomId = request.roomId;
    // Synthetic tasks and messages without an exact room identity stay self-contained.
    if (typeof roomId !== "string" || !roomId || !source || !isRoomMessage(source)
      || (source.room_id !== undefined && source.room_id !== roomId)) {
      this.reset();
      return { lines: formatRoomTurnContext(request), commit: () => {} };
    }
    const scope = JSON.stringify([continuationId, roomId]);
    if (scope !== this.scope) { this.reset(); this.scope = scope; }
    const revision = this.revision;
    const context = (request.observedContext ?? []).map(conversationMessage);
    const next = new Map<string, unknown>();
    const ambiguous = new Set<string>();
    for (const value of [...context, source]) {
      const message = record(value);
      if (!message || !isRoomMessage(message) || (message.room_id !== undefined && message.room_id !== roomId)) continue;
      const id = String(message.id);
      if (next.has(id) && !isDeepStrictEqual(next.get(id), message)) ambiguous.add(id);
      next.set(id, structuredClone(message));
    }
    for (const id of ambiguous) next.delete(id);
    let reused = false;
    const incremental = context.map((value, index) => {
      const message = record(value);
      // Always repeat human instructions, the immediate exchange and the source.
      // Only older unchanged agent messages can refer back to retained history.
      if (!message || !isRoomMessage(message) || (message.room_id !== undefined && message.room_id !== roomId) || message.source !== "agent"
        || message.id === source.id || index >= context.length - 3 || ambiguous.has(String(message.id))
        || !isDeepStrictEqual(this.messages.get(String(message.id)), message)) return value;
      reused = true;
      return { id: message.id, room_id: roomId, previously_supplied: true };
    });
    const lines = formatRoomTurnContext({ ...request, observedContext: incremental });
    if (reused) lines.unshift("Room messages marked previously_supplied are unchanged messages already supplied in this native conversation, in their original room order. Use that retained context; retrieve the message with room context tools if its details are missing. New or edited messages, human instructions, and the immediate exchange are included in full below.");
    return { lines, commit: () => {
      // Compaction or disconnect during the turn invalidates its assumptions.
      if (this.revision === revision && this.scope === scope) this.messages = next;
    } };
  }
}

export const MANAGED_ROOM_WORK_INSTRUCTIONS = [
  ROOM_EXPRESSION_GUIDANCE,
  "You are responding to a daemon-owned room inbox item. Carry out any work it assigns or continues.",
  "The source message triggered this turn; it may not be the latest instruction. Read the supplied room context in order. Newer human corrections on the same topic amend the earlier request. Do not repeat an outdated plan or invent a correction you have not seen; unrelated newer topics do not cancel this work.",
  "The daemon owns room observation, worker credentials, delivery retries, and publication of your final chat reply. Do not register a session, authenticate LetAgents, poll, or manage runtime lifecycle.",
  "Answer ordinary top-level room questions in the main room by default; answering a specific message is not by itself a reason to start a thread. Existing thread replies stay in their thread automatically. Start a new thread only when the user asks for one or a sustained side discussion would distract from the room. In that case, call set_reply_thread with no arguments when available, then finish through your normal final completion. It records only the thread choice and does not send text or end the turn. Use message tools only for separate messages; synthetic corrections and task continuations have no new room thread to select.",
  "Continue authorized work through implementation, verification, code publication, and review handoff before ending your turn. A progress report or a promise to continue is not completion. If a real dependency blocks you, complete the available steps and identify the specific blocker and who can resolve it.",
  "When the next step depends on something that has not happened yet (CI finishing, a review, a task moving, a later time) and add_wake_rule is available, add a wake rule and end your turn. Saying you will check back later does not bring you back.",
  "LetAgents room tools do not provide browser automation or a preview service. Use only capabilities actually exposed and authorized in this runtime; a repository path, shell tool, or preview URL does not establish browser access. Shell, HTTP, and DOM unit checks are not browser QA.",
  "When a required capability is missing, report the specific gap once and continue independent feasible work. After completing available steps, use the existing task/status tools within your authority to record the remaining blocker and leave affected verification incomplete; never mark an unperformed check as passed or its task done.",
  "Do not repeat an unchanged capability attempt or blocker report without new capability, permission, input, or evidence. Still respond to explicit user instructions and new questions; reassess changed requests without bypassing the runtime boundary.",
  "For acknowledgment-only closing messages or unchanged blocker reminders with no new request, avoid another courtesy text reply. When a useful acknowledgment fits, you may react using the expression guidance, then use the no-reply completion below. Otherwise finish silently. A closing @mention alone does not require an acknowledgment or verification run; do not mention peers merely to repeat that work remains blocked.",
  "You are responsible for committing, pushing, opening PRs, and merging when authorized using the available repository tools. The daemon's chat reply publication does not publish code or create PRs. Arrange independent review with another agent; do not treat your own tests as a review.",
  "Honor the user's existing authorization, including standing merge approval. After independent review and required checks pass, perform an authorized merge and update the task board instead of asking the user to click Merge. Ask for approval only when the next action exceeds that authorization or needs a new human decision; never bypass repository rules or permissions.",
] as const;

export function summarizeTaskEvent(task: DesktopTaskSummary): string {
  return [
    `Task id: ${task.id}`,
    `Title: ${task.title}`,
    `Status: ${task.status}`,
    `Assignee: ${task.assignee || "none"}`,
    `Assignee agent key: ${task.assigneeAgentKey || "none"}`,
    `Created by: ${task.createdBy || "unknown"}`,
    task.prUrl ? `Pull request: ${task.prUrl}` : null,
    `Created: ${task.createdAt || "unknown"}`,
    `Updated: ${task.updatedAt || "unknown"}`,
    "",
    "Active leases:",
    ...formatLeases(task),
    "",
    "Workflow refs:",
    ...formatWorkflowRefs(task),
    "",
    "Workflow artifacts:",
    ...formatWorkflowArtifacts(task),
    "",
    "Active locks:",
    ...formatLocks(task),
    task.stalePromptState?.isStale
      ? `Stale prompt: ${task.stalePromptState.reason || "stale"} for ${task.stalePromptState.staleForMs ?? "unknown"}ms`
      : null,
    "",
    "Description:",
    task.description || "(empty)",
  ].filter((line): line is string => line !== null).join("\n");
}

function formatLeases(task: DesktopTaskSummary): string[] {
  if (!task.activeLeases.length) {
    return ["- none"];
  }

  return task.activeLeases.slice(0, 8).map((lease) => [
    `- ${lease.kind}`,
    lease.holderLabel ? `holder=${lease.holderLabel}` : null,
    lease.agentKey ? `agentKey=${lease.agentKey}` : null,
    lease.agentSessionId ? `agentSession=${lease.agentSessionId}` : null,
    `status=${lease.status}`,
    lease.updatedAt ? `updated=${lease.updatedAt}` : null,
  ].filter(Boolean).join(" "));
}

function formatWorkflowRefs(task: DesktopTaskSummary): string[] {
  if (!task.workflowRefs.length) {
    return ["- none"];
  }

  return task.workflowRefs.slice(0, 6).map((ref) =>
    `- ${ref.provider}/${ref.kind}: ${ref.label} ${ref.url}`
  );
}

function formatWorkflowArtifacts(task: DesktopTaskSummary): string[] {
  if (!task.workflowArtifacts.length) {
    return ["- none"];
  }

  return task.workflowArtifacts.slice(0, 6).map((artifact) => [
    `- ${artifact.provider}/${artifact.kind}`,
    artifact.number !== null ? `#${artifact.number}` : null,
    artifact.title || artifact.ref || artifact.id,
    artifact.state ? `state=${artifact.state}` : null,
    artifact.url || null,
  ].filter(Boolean).join(" "));
}

function formatLocks(task: DesktopTaskSummary): string[] {
  if (!task.activeLocks.length) {
    return ["- none"];
  }

  return task.activeLocks.slice(0, 6).map((lock) => [
    `- ${lock.scope}`,
    lock.reason ? `reason=${lock.reason}` : null,
    lock.message ? `message=${lock.message}` : null,
    lock.createdBy ? `createdBy=${lock.createdBy}` : null,
  ].filter(Boolean).join(" "));
}

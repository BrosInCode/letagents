/** Room-turn prompt input and how a finished OpenCode turn is classified, including denied and unfinished tool calls. */
import { formatRoomTurnContext, includedRoomTurnImages, MANAGED_ROOM_WORK_INSTRUCTIONS } from "../desktop-event-prompt-format.js";
import { NO_REPLY_FAILURE } from "../../../../../../shared/room-turn-no-reply.mjs";
import type { ProviderRoomTurnRequest, ProviderRoomTurnResult } from "../provider-adapter.js";
import { messageFinishReason, messageText, record, type JsonRecord, type OpenCodeMessage } from "../opencode-server-client.js";
import { NO_REPLY_SENTINEL } from "./types.js";

/**
 * OpenCode takes an image as a file part with a data URL, and resizes a large
 * one before it is saved with the session. Each image follows a short label.
 */
export function roomTurnImageParts(request: ProviderRoomTurnRequest): Array<Record<string, unknown>> {
  return includedRoomTurnImages(request.attachments).flatMap(image => image.data ? [
    { type: "text", text: `Image ${image.number}: ${JSON.stringify(image.fileName)}` },
    { type: "file", mime: image.mimeType, filename: image.fileName,
      url: `data:${image.mimeType};base64,${Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).toString("base64")}` },
  ] : []);
}

export function boundedRoomTurnPrompt(request: ProviderRoomTurnRequest): string {
  return [
    ...MANAGED_ROOM_WORK_INSTRUCTIONS,
    "You may use the discovered LetAgents product tools for bounded room context, tasks, artifacts, status, deliberate side messages, or moving to another room. Those actions are daemon-mediated.",
    "A GitHub webfetch 404 can mean private access, not a missing PR. Check with gh using its existing authentication before concluding the PR is missing; GH_CONFIG_DIR preserves the user's configured GitHub CLI location.",
    "An explicit git fetch may update only FETCH_HEAD. Inspect FETCH_HEAD or another verified ref before concluding a remote branch has no changes.",
    "Answer the activating message in your final response; do not send that same reply with a message tool.",
    `If no response should be published, return exactly ${NO_REPLY_SENTINEL} with no other text.`,
    `Inbox item: ${request.inboxItemId}`,
    ...formatRoomTurnContext(request),
  ].join("\n");
}

export function classifyTurn(turnId: string, text: string | null): ProviderRoomTurnResult {
  const normalized = text?.trim() || null;
  if (!normalized) return { turnId, outcome: "unreadable", text: null, evidence: "none" };
  if (normalized === NO_REPLY_SENTINEL) {
    return { turnId, outcome: "no_reply", text: null, evidence: "transcript" };
  }
  return { turnId, outcome: "reply", text: normalized, evidence: "transcript" };
}

/** OpenCode 1.18.20 `PermissionV1.RejectedError`, also the start of its `CorrectedError`. */
export const OPENCODE_PERMISSION_REJECTED = "The user rejected permission to use this specific tool call";
/**
 * A denied call no longer ends the turn (continue_loop_on_deny), so a model
 * could retry what it was refused for as long as someone keeps refusing.
 * This many steps in a row in which every tool call was denied end the turn
 * as if OpenCode had stopped at the first. Steps, not calls: one decision
 * rejects every request pending in the session, so a single step with
 * parallel calls is one refusal.
 */
export const MAX_CONSECUTIVE_DENIED_STEPS = 3;

export type TurnStep = {
  created: number;
  completed: boolean;
  aborted: boolean;
  text: boolean;
  /** callID -> whether it was denied, or null while it has not finished. */
  tools: Map<string, boolean | null>;
};

export function deniedToolState(state: JsonRecord | null): boolean {
  return state?.status === "error" && typeof state.error === "string"
    && state.error.startsWith(OPENCODE_PERMISSION_REJECTED);
}

/** Why a turn whose last step's tool calls never returned has no answer. */
export const TOOL_CALLS_UNFINISHED = "The turn ended while a tool call it made was still running, so it has no answer.";

/**
 * A step that ended on tool calls, some of which never returned a result.
 * Its text is what the model said before it called them, not an answer:
 * the turn was meant to go on once the results came back.
 */
export function unfinishedToolCalls(message: OpenCodeMessage | null): boolean {
  return messageFinishReason(message) === "tool-calls" && (message?.parts ?? []).some((part) => part.type === "tool"
    && !["completed", "error"].includes(String(record(part.state)?.status ?? "")));
}

export function deniedToolCall(message: OpenCodeMessage): boolean {
  return (message.parts ?? []).some((part) => part.type === "tool" && deniedToolState(record(part.state)));
}

/**
 * Why a completed step that OpenCode ended with a finish reason has no answer.
 * OpenCode writes every text part before it marks the step completed, so a
 * re-read can only return the same empty answer: this is a settled failure,
 * not an unreadable result. A step without a finish reason (for example one
 * stopped while a retry was waiting) remains unreadable.
 */
export function unansweredCompletionReason(message: OpenCodeMessage): string | null {
  if (messageText(message)) return null;
  const finish = messageFinishReason(message);
  // OpenCode ends its loop on a step whose tool call was rejected, unless
  // it runs with continue_loop_on_deny (runtimes started earlier).
  if (finish === "tool-calls") return deniedToolCall(message) ? NO_REPLY_FAILURE.deniedTool : null;
  if (!finish) return null;
  if (finish === "length") return NO_REPLY_FAILURE.outputLimit;
  if (finish === "content-filter") return NO_REPLY_FAILURE.contentFilter;
  return NO_REPLY_FAILURE.emptyAnswer;
}

/** The room-turn prompt Antigravity gets, and how a finished ACP prompt becomes a room-turn result. */
import { formatRoomTurnContext, includedRoomTurnImages, MANAGED_ROOM_WORK_INSTRUCTIONS, roomTurnImageLabel } from "../desktop-event-prompt-format.js";
import { NO_REPLY_FAILURE } from "../../../../../../shared/room-turn-no-reply.mjs";
import type { ProviderRoomTurnRequest, ProviderRoomTurnResult } from "../provider-adapter.js";
import { ANTIGRAVITY_NO_ROOM_REPLY_SENTINEL, type AntigravityLaunchAuthority } from "./launch.js";

/**
 * What the agent's access level lets it do, said on every turn. agy does not
 * know that LetAgents refuses its permission requests, and a refused request
 * ends the turn at once with no reply, so an agent that is not told keeps
 * trying. The level can change between turns, and the conversation still
 * holds what earlier turns said, so each turn names the level it runs under.
 */
export function antigravityAccessLevelLines(authority: AntigravityLaunchAuthority | null): string[] {
  if (!authority) return [];
  if (authority.hostDecision === "ask") {
    return ["Your access level for this turn is Ask before writes: reading files and the LetAgents room tools need no approval, and each file edit and shell command waits for your owner's approval. A refused action ends your turn with no reply. This replaces any access level named earlier in this conversation."];
  }
  if (authority.hostDecision === "allow") {
    return ["Your access level for this turn is Full access: file edits and shell commands run without asking. This replaces any access level named earlier in this conversation."];
  }
  return authority.agentMode === "auto"
    ? ["Your access level for this turn is Auto: your own review approves edits and safe commands. An action it would ask about is refused, and a refused action ends your turn with no reply. Avoid such actions; when the task needs one, say so in your answer instead. This replaces any access level named earlier in this conversation."]
    : ["Your access level for this turn is Read-only: every file edit and shell command is refused, and a refused action ends your turn with no reply. Do not try them. Read files, use the LetAgents room tools, and answer; when the task needs an edit or a command, say that it needs a higher access level. This replaces any access level named earlier in this conversation."];
}

export function boundedAntigravityRoomTurnPrompt(
  request: ProviderRoomTurnRequest,
  context: string[] = formatRoomTurnContext(request),
  authority: AntigravityLaunchAuthority | null = null,
): string {
  return [
    ...MANAGED_ROOM_WORK_INSTRUCTIONS,
    ...antigravityAccessLevelLines(authority),
    "You may use the discovered LetAgents product tools (named mcp_letagents_…) for room context, tasks, artifacts, status, deliberate side messages, or moving to another room. Those actions are daemon-mediated.",
    "Answer the activating message in your final response; do not send that same reply with a message tool.",
    `If no response should be published, return exactly ${ANTIGRAVITY_NO_ROOM_REPLY_SENTINEL} with no other text.`,
    `Inbox item: ${request.inboxItemId}`,
    ...context,
  ].join("\n");
}

/** ACP content blocks for one room turn: the prompt text, then each included image after its label. */
export function antigravityPromptBlocks(text: string, request: ProviderRoomTurnRequest): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [{ type: "text", text }];
  for (const image of includedRoomTurnImages(request.attachments)) {
    if (!image.data) continue;
    blocks.push({ type: "text", text: roomTurnImageLabel(image) });
    blocks.push({
      type: "image",
      mimeType: image.mimeType,
      data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).toString("base64"),
    });
  }
  return blocks;
}

/** What one ACP prompt left behind, as the adapter collected it from the update stream. */
export type AntigravityTurnEvidence = {
  stopReason: string | null;
  text: string;
  /** A permission request this host refused during the turn. */
  refusedTool: boolean;
  /** The prompt request itself failed, with the agent's own message. */
  error: string | null;
};

/**
 * Classify a finished prompt. `end_turn` with text is the answer. agy ends a
 * turn with no text right after a refused tool call, and reports an exhausted
 * quota as `refusal`; both are settled failures, not unreadable results.
 */
export function classifyAntigravityTurn(turnId: string, providerContinuationId: string, evidence: AntigravityTurnEvidence): ProviderRoomTurnResult {
  const failed = (error: string, extra: { refusal?: true } = {}): ProviderRoomTurnResult =>
    ({ turnId, providerContinuationId, outcome: "failed", text: null, evidence: "stream", error, ...extra });
  if (evidence.error) return failed(evidence.error);
  const text = evidence.text.trim();
  switch (evidence.stopReason) {
    case "cancelled":
      return { turnId, providerContinuationId, outcome: "interrupted", text: null, evidence: "stream", error: "The turn was stopped." };
    case "refusal":
      return failed(text || "Antigravity refused this turn. The account may have reached its usage limit.", { refusal: true });
    case "max_tokens":
      return failed(NO_REPLY_FAILURE.outputLimit);
    case "max_turn_requests":
      return failed("Antigravity reached its limit of model requests for one turn before it wrote a reply.");
    case "end_turn":
      break;
    default:
      return { turnId, providerContinuationId, outcome: "failed", text: null, evidence: "stream",
        error: `Antigravity ended the turn with an unknown stop reason${evidence.stopReason ? ` (${evidence.stopReason.slice(0, 40)})` : ""}.`,
        unrecognizedResult: true };
  }
  if (!text) return failed(evidence.refusedTool ? NO_REPLY_FAILURE.deniedTool : NO_REPLY_FAILURE.emptyAnswer);
  if (text === ANTIGRAVITY_NO_ROOM_REPLY_SENTINEL) return { turnId, outcome: "no_reply", text: null, evidence: "stream" };
  return { turnId, outcome: "reply", text, evidence: "stream" };
}

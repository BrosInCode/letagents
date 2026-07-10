import type { DesktopRoomStreamEvent } from "../../ipc-types.js";
import { DESKTOP_EVENTS_NO_ROOM_REPLY } from "./codex-event-prompt.js";
import { summarizeTaskEvent } from "./desktop-event-prompt-format.js";
import { summarizeDesktopEventMessage } from "./desktop-event-message-summary.js";
import {
  managedAgentRoomToolInstructionLines,
} from "./managed-agent-room-tools-protocol.js";
import type { DesktopClaudeCodeLiveSessionState } from "./state.js";

export function buildClaudeCodeDesktopEventPrompt(
  session: DesktopClaudeCodeLiveSessionState,
  event: Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>,
): string {
  const eventBody = event.type === "message"
    ? summarizeDesktopEventMessage(event.message, { displayName: session.display_name })
    : summarizeTaskEvent(event.task);
  return [
    "Desktop-delivered LetAgents room event.",
    `Room: ${session.room_identifier || session.room_id}`,
    `Event type: ${event.type}`,
    "",
    "Local worker context:",
    `Registered agent_session_id: ${session.agent_session_id || "not registered"}`,
    `Display name: ${session.display_name || "unknown"}`,
    `Runtime marker: claude-code:${session.token}`,
    "",
    eventBody,
    "",
    "Instructions:",
    `- If this is a room message whose text exactly equals ${JSON.stringify(session.stop_phrase)}, stop this local worker: finish with exactly ${session.token}_DONE.`,
    "- Decide whether this event requires action from you.",
    ...managedAgentRoomToolInstructionLines(),
    "- Do not assume earlier thread history is already in this prompt.",
    "- If action is useful, do the local work in this Claude Code session and make your final answer the public room reply the desktop should publish as you.",
    "- If this message is a reply, write the final answer as the reply text; the desktop will keep it in the same thread.",
    "- In public room replies, never mention control markers, Result JSON, desktop bridge details, or internal tool request syntax.",
    "- For task_update events, act only when the task is unclaimed and appropriate for you, assigned or leased to you, needs your review, or contains a blocker that you can resolve. If it is assigned or leased to another worker, finish quietly.",
    `- If no public room reply is needed, finish with exactly ${DESKTOP_EVENTS_NO_ROOM_REPLY}.`,
    "- Do not include hidden chain-of-thought in the final answer.",
  ].join("\n");
}

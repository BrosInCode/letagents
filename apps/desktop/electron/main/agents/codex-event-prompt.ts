import type { DesktopRoomStreamEvent } from "../../ipc-types.js";
import { summarizeTaskEvent } from "./desktop-event-prompt-format.js";
import { summarizeDesktopEventMessage } from "./desktop-event-message-summary.js";
import {
  hasManagedAgentContextRequestLine,
  MANAGED_AGENT_CONTEXT_REQUEST_PREFIX,
} from "./managed-agent-context-protocol.js";
import {
  hasManagedAgentRoomToolRequestLine,
  MANAGED_AGENT_ROOM_TOOL_REQUEST_PREFIX,
  managedAgentRoomToolInstructionLines,
} from "./managed-agent-room-tools-protocol.js";
import type { DesktopCodexLiveSessionState } from "./state.js";

export const DESKTOP_EVENTS_NO_ROOM_REPLY = "NO_ROOM_REPLY";

export function desktopEventPublicReplyText(
  sessionToken: string | null | undefined,
  value: string | null | undefined,
): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || hasDesktopEventControlMarkerLine(trimmed, sessionToken)) {
    return null;
  }
  if (
    trimmed.includes(MANAGED_AGENT_CONTEXT_REQUEST_PREFIX)
    || trimmed.includes(MANAGED_AGENT_ROOM_TOOL_REQUEST_PREFIX)
  ) {
    return null;
  }
  if (hasManagedAgentContextRequestLine(trimmed)) {
    return null;
  }
  if (hasManagedAgentRoomToolRequestLine(trimmed)) {
    return null;
  }
  return trimmed;
}

function hasDesktopEventControlMarkerLine(
  value: string,
  sessionToken: string | null | undefined,
): boolean {
  const stopMarker = sessionToken ? `${sessionToken}_DONE` : null;
  return value.split(/\r?\n/)
    .map((line) => stripDesktopEventControlLineDecoration(line))
    .some((line) =>
      line === DESKTOP_EVENTS_NO_ROOM_REPLY ||
      Boolean(stopMarker && line === stopMarker)
    );
}

function stripDesktopEventControlLineDecoration(line: string): string {
  let candidate = line.trim();
  while (candidate.startsWith(">")) {
    candidate = candidate.slice(1).trimStart();
  }
  const listPrefix = /^(?:[-*+]\s+|\d+[.)]\s+)/.exec(candidate);
  if (listPrefix) {
    candidate = candidate.slice(listPrefix[0].length).trimStart();
  }
  return candidate;
}

export function buildDesktopEventPrompt(
  session: DesktopCodexLiveSessionState,
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
    `Runtime marker: codex:${session.token}`,
    "",
    eventBody,
    "",
    "Instructions:",
    `- If this is a room message whose text exactly equals ${JSON.stringify(session.stop_phrase)}, stop this local worker: finish with exactly ${session.token}_DONE.`,
    "- Decide whether this event requires action from you.",
    ...managedAgentRoomToolInstructionLines(),
    "- Do not assume earlier thread history is already in this prompt.",
    "- If you need older room or thread context, use the desktop context tools by finishing this turn with exactly one context request line:",
    `  ${MANAGED_AGENT_CONTEXT_REQUEST_PREFIX} {"tool":"read_thread","arguments":{"root_message_id":"msg_12","limit":40}}`,
    "- Available desktop context tools: read_recent_room_messages, search_room_messages, read_thread, read_messages_around, get_task_context, get_room_context_summary.",
    "- Context tools are read-only, room-scoped, desktop-brokered, and return compact results. Use them only when needed.",
    "- If action is useful, do the local work in this Codex thread and make your final answer the public room reply the desktop should publish as you.",
    "- If this message is a reply, write the final answer as the reply text; the desktop will keep it in the same thread.",
    "- In public room replies, never mention control markers, Result JSON, desktop bridge details, or internal tool request syntax.",
    "- For task_update events, act only when the task is unclaimed and appropriate for you, assigned or leased to you, needs your review, or contains a blocker that you can resolve. If it is assigned or leased to another worker, finish quietly.",
    `- If no public room reply is needed, finish with exactly ${DESKTOP_EVENTS_NO_ROOM_REPLY}.`,
    "- Do not include hidden chain-of-thought in the final answer.",
  ].join("\n");
}

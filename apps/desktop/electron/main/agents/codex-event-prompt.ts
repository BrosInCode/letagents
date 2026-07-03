import type {
  DesktopRoomStreamEvent,
  DesktopTaskSummary,
} from "../../ipc-types.js";
import { summarizeDesktopEventMessage } from "./desktop-event-message-summary.js";
import {
  hasManagedAgentContextRequestLine,
  MANAGED_AGENT_CONTEXT_REQUEST_PREFIX,
} from "./managed-agent-context-protocol.js";
import {
  hasManagedAgentRoomToolRequestLine,
  managedAgentRoomToolInstructionLines,
} from "./managed-agent-room-tools-protocol.js";
import type { DesktopCodexLiveSessionState } from "./state.js";

export const DESKTOP_EVENTS_NO_ROOM_REPLY = "NO_ROOM_REPLY";

export function desktopEventPublicReplyText(
  sessionToken: string | null | undefined,
  value: string | null | undefined,
): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed === DESKTOP_EVENTS_NO_ROOM_REPLY) {
    return null;
  }
  if (sessionToken && trimmed === `${sessionToken}_DONE`) {
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
    "- For task_update events, act only when the task is unclaimed and appropriate for you, assigned or leased to you, needs your review, or contains a blocker that you can resolve. If it is assigned or leased to another worker, finish quietly.",
    `- If no public room reply is needed, finish with exactly ${DESKTOP_EVENTS_NO_ROOM_REPLY}.`,
    "- Do not include hidden chain-of-thought in the final answer.",
  ].join("\n");
}

function summarizeTaskEvent(task: DesktopTaskSummary): string {
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

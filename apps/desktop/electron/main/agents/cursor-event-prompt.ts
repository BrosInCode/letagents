import type {
  DesktopRoomStreamEvent,
  DesktopTaskSummary,
} from "../../ipc-types.js";
import { DESKTOP_EVENTS_NO_ROOM_REPLY } from "./codex-event-prompt.js";
import { summarizeDesktopEventMessage } from "./desktop-event-message-summary.js";
import {
  cursorPermissionProfileInstructionLines,
  cursorPermissionProfileRuntimeLine,
} from "./cursor-permission-profile.js";
import {
  managedAgentRoomToolInstructionLines,
} from "./managed-agent-room-tools-protocol.js";
import type { DesktopCursorLiveSessionState } from "./state.js";

export function buildCursorDesktopEventPrompt(
  session: DesktopCursorLiveSessionState,
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
    `Runtime marker: cursor:${session.token}`,
    cursorPermissionProfileRuntimeLine(session.permission_profile_id),
    "",
    eventBody,
    "",
    "Instructions:",
    `- If this is a room message whose text exactly equals ${JSON.stringify(session.stop_phrase)}, stop this local worker: finish with exactly ${session.token}_DONE.`,
    "- Decide whether this event requires a response or local action from you.",
    ...managedAgentRoomToolInstructionLines(),
    "- Do not assume earlier thread history is already in this prompt.",
    ...cursorPermissionProfileInstructionLines(session.permission_profile_id),
    "- If this message is a reply, write the final answer as the reply text; the desktop will keep it in the same thread.",
    "- In public room replies, never mention control markers, Result JSON, desktop bridge details, or internal tool request syntax.",
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

import type {
  DesktopReasoningSession,
  DesktopRoomMessage,
} from "../../../../../../electron/ipc-types";
import { displayNameFromActor, normalizeAgentKey } from "../../../../domain/agents";
import {
  type ReasoningAgentTarget,
  reasoningAgentTargetKeys,
} from "../../../../domain/reasoning";

export function buildAgentFallbackReasoningSession(
  target: ReasoningAgentTarget,
  roomIdentifier: string,
  messages: readonly DesktopRoomMessage[],
): DesktopReasoningSession {
  const actorLabel = target.actorLabel || target.sender || target.displayName;
  const latestMessage = latestMessageForAgent(target, messages);
  const latestText = latestMessage ? stripStatusPrefix(latestMessage.text) : "";
  const timestamp = latestMessage?.timestamp || new Date().toISOString();
  const status = inferAgentFallbackStatus(latestText);
  const summary = latestText
    ? `No live reasoning stream yet. Latest room activity: ${latestText}`
    : "No live reasoning stream yet.";
  const checking = latestText
    ? "No reasoning stream has been published yet; showing the agent's latest room activity while waiting for Codex runtime events."
    : "Waiting for Codex runtime events or reasoning updates.";
  const nextAction = latestText
    ? "This view will switch to live reasoning when the agent publishes a stream event or reasoning update."
    : "This view will update when the agent publishes its first reasoning update.";

  return {
    id: `pending-agent-reasoning:${sanitizeFallbackId(actorLabel)}`,
    roomId: roomIdentifier,
    actorLabel,
    agentKey: null,
    taskId: null,
    title: "Waiting for live reasoning",
    status,
    summary,
    latestPayload: {
      summary,
      goal: `${target.displayName} reasoning`,
      checking,
      next_action: nextAction,
      status,
    },
    goal: `${target.displayName} reasoning`,
    checking,
    hypothesis: null,
    blocker: null,
    nextAction,
    milestone: null,
    confidence: null,
    closedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function latestMessageForAgent(
  target: ReasoningAgentTarget,
  messages: readonly DesktopRoomMessage[],
): DesktopRoomMessage | null {
  const keys = reasoningAgentTargetKeys(target);
  if (!keys.length) return null;
  return [...messages]
    .reverse()
    .find((message) => message.source === "agent" && messageKeys(message).some((key) => keys.includes(key))) || null;
}

export function inferAgentFallbackStatus(value: string): "idle" | "working" | "reviewing" | "blocked" {
  const text = value.toLowerCase();
  if (text.includes("blocked")) return "blocked";
  if (text.includes("review")) return "reviewing";
  if (/(working|debugging|checking|inspecting|running|testing|building|implementing)/i.test(text)) return "working";
  return "idle";
}

export function sanitizeFallbackId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-") || "agent";
}

export function stripStatusPrefix(value: string): string {
  return value.replace(/^\[status\]\s*/i, "").trim();
}

function messageKeys(message: DesktopRoomMessage): string[] {
  return [
    message.sender,
    message.actorLabel,
    message.agentIdentity?.actorLabel,
    message.agentIdentity?.displayName,
    displayNameFromActor(message.sender),
  ].map(normalizeAgentKey).filter(Boolean);
}

import type { DesktopRoomMessage } from "../../ipc-types.js";
import { describeDesktopEventMessageAttachments } from "./managed-agent-attachments.js";

export type DesktopEventMessageWorkerIdentity = {
  displayName?: string | null;
  actorLabel?: string | null;
};

/**
 * Builds the message section of a desktop-delivered managed agent event prompt.
 *
 * Shared by the Codex, Claude Code, and Cursor event prompt builders so that
 * every runtime sees the same thread metadata. Without the thread lines a
 * human reply inside a thread looks like an unrelated human-to-human exchange
 * ("Reply to: msg_X from EmmyMay") and workers rationally answer NO_ROOM_REPLY
 * even though the thread is a conversation they are part of.
 */
export function summarizeDesktopEventMessage(
  message: DesktopRoomMessage,
  worker: DesktopEventMessageWorkerIdentity = {},
): string {
  return [
    `Message id: ${message.id}`,
    `Sender: ${message.sender}`,
    `Actor: ${message.actorLabel || message.agentIdentity?.actorLabel || "unknown"}`,
    message.agentIdentity?.agentKey ? `Agent key: ${message.agentIdentity.agentKey}` : null,
    message.agentIdentity?.agentSessionId ? `Agent session: ${message.agentIdentity.agentSessionId}` : null,
    `Source: ${message.source || "room"}`,
    `Timestamp: ${message.timestamp}`,
    message.replyTo ? `Reply to: ${message.replyTo.id} from ${message.replyTo.sender}` : null,
    ...describeThreadContext(message, worker),
    ...describeDesktopEventMessageAttachments(message),
    "",
    "Text:",
    message.text || "(empty)",
  ].filter((line): line is string => line !== null).join("\n");
}

function describeThreadContext(
  message: DesktopRoomMessage,
  worker: DesktopEventMessageWorkerIdentity,
): string[] {
  const threadRootId = message.threadRootId?.trim() || "";
  if (!threadRootId || threadRootId === message.id) {
    // Top-level messages (including bare quote-replies that root at themselves)
    // carry no thread lines, matching the server's thread membership rule.
    return [];
  }

  const threadReplyToId = message.threadReplyToId?.trim() || message.replyTo?.id || threadRootId;
  const threadReplyToSender = message.replyTo?.id === threadReplyToId
    ? message.replyTo.sender
    : null;
  const threadRootSender = message.replyTo?.id === threadRootId
    ? message.replyTo.sender
    : null;

  const lines = [
    `Thread root: ${threadRootId}${threadRootSender ? ` from ${threadRootSender}` : ""}`,
    `Thread reply to: ${threadReplyToId} from ${threadReplyToSender || "unknown sender"}`,
  ];

  const humanSender = !message.agentIdentity && message.source !== "agent";
  if (workerParticipatesInThread(message, worker)) {
    lines.push(
      humanSender
        ? "Thread context: this is a human reply inside a thread you are participating in. Treat it as addressed to you even when the reply target above is another sender's message, and answer in this same thread unless it clearly asks for a different worker."
        : "Thread context: this is a reply inside a thread you are participating in. Treat it as part of your conversation and answer in this same thread when a response is useful.",
    );
  } else {
    lines.push(
      "Thread context: this message is a reply inside an existing thread, not a private exchange between the senders shown above. Check the thread before deciding it does not involve you.",
    );
  }
  return lines;
}

function workerParticipatesInThread(
  message: DesktopRoomMessage,
  worker: DesktopEventMessageWorkerIdentity,
): boolean {
  const workerNames = new Set(
    [worker.displayName, worker.actorLabel].map(normalizeSenderKey).filter(Boolean),
  );
  if (!workerNames.size) {
    return false;
  }

  const threadSenders = [
    message.replyTo?.sender,
    message.thread?.latestReply?.sender,
    ...(message.thread?.participants || []).map((participant) => participant.sender),
  ];
  return threadSenders.some((sender) => senderMatchesWorker(sender, workerNames));
}

function senderMatchesWorker(
  sender: string | null | undefined,
  workerNames: ReadonlySet<string>,
): boolean {
  const normalized = normalizeSenderKey(sender);
  if (!normalized) {
    return false;
  }
  if (workerNames.has(normalized)) {
    return true;
  }
  // Managed agent senders are composites like "CedarVista | Local desktop | Codex".
  return String(sender)
    .split("|")
    .some((part) => workerNames.has(normalizeSenderKey(part)));
}

function normalizeSenderKey(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

import type {
  DesktopManagedAgentSession,
  DesktopRoomMessage,
  DesktopRoomStreamEvent,
} from "../../ipc-types.js";
import {
  managedAgentDeliveryMode,
  toPublicManagedAgentSession,
  type DesktopCodexLiveSessionState,
} from "./state.js";

export function canDeliverDesktopEventToSession(
  session: DesktopCodexLiveSessionState,
): boolean {
  return canDeliverDesktopEventToManagedAgent({
    ...toPublicManagedAgentSession(session),
    deliveryMode: managedAgentDeliveryMode(session),
    status: session.status,
  });
}

export function canDeliverDesktopEventToManagedAgent(
  worker: Pick<DesktopManagedAgentSession, "agentSessionId" | "deliveryMode" | "status">,
): boolean {
  return worker.deliveryMode === "desktop_events" &&
    Boolean(worker.agentSessionId) &&
    worker.status !== "blocked" &&
    worker.status !== "interrupted" &&
    worker.status !== "failed";
}

export function canDeliverCodexStopControlToManagedAgent(
  worker: Pick<DesktopManagedAgentSession, "agentSessionId" | "canStop" | "deliveryMode" | "status">,
): boolean {
  return worker.deliveryMode === "desktop_events" &&
    Boolean(worker.agentSessionId) &&
    worker.canStop &&
    worker.status !== "interrupted" &&
    worker.status !== "failed";
}

export function isOwnRoomStreamEvent(
  session: DesktopCodexLiveSessionState,
  event: Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>,
): boolean {
  return isOwnRoomStreamEventForManagedAgent(toPublicManagedAgentSession(session), event);
}

export function isOwnRoomStreamEventForManagedAgent(
  worker: Pick<DesktopManagedAgentSession, "agentSessionId" | "agentKey" | "actorLabel" | "displayName">,
  event: Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>,
): boolean {
  if (event.type !== "message") {
    return false;
  }

  const message = event.message;
  const messageStableKeys = [
    message.agentIdentity?.agentSessionId,
    specificAgentKey(message.agentIdentity?.agentKey),
  ].map(normalizeKey).filter(Boolean);
  const workerStableKeys = [
    worker.agentSessionId,
    specificAgentKey(worker.agentKey),
  ].map(normalizeKey).filter(Boolean);
  if (messageStableKeys.length && workerStableKeys.length) {
    return workerStableKeys.some((key) => messageStableKeys.includes(key));
  }

  const messageNames = [
    message.actorLabel,
    message.agentIdentity?.actorLabel,
    message.agentIdentity?.displayName,
    message.sender,
  ].map(normalizeKey).filter(Boolean);
  const workerNames = [
    worker.actorLabel,
    worker.displayName,
  ].map(normalizeKey).filter(Boolean);
  return Boolean(messageNames.length && workerNames.some((key) => messageNames.includes(key)));
}

export function shouldDeliverRoomStreamEventToSession(
  session: DesktopCodexLiveSessionState,
  event: Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>,
): boolean {
  return shouldDeliverRoomStreamEventToManagedAgent(toPublicManagedAgentSession(session), event);
}

/**
 * Codex room workers share a transcript, but they do not share an inbox.
 *
 * This is deliberately narrower than the legacy, provider-neutral desktop
 * event router below.  A Codex worker is activated only by an explicit
 * address, an @everyone broadcast, an assignment/lease to that worker, or an
 * active thread it participates in.  In particular, an unaddressed message is
 * context for a later turn, never a reason to start one for every worker.
 */
export function shouldDeliverCodexRoomStreamEventToSession(
  session: DesktopCodexLiveSessionState,
  event: Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>,
): boolean {
  const worker = toPublicManagedAgentSession(session);
  if (isOwnRoomStreamEventForManagedAgent(worker, event)) {
    return false;
  }
  // A locally-configured stop phrase is supervisor control, not ordinary room
  // conversation. It must remain deliverable even when unaddressed.
  if (isStopPhraseRoomStreamEvent(session, event)) {
    return canDeliverCodexStopControlToManagedAgent(worker);
  }
  return shouldDeliverCodexRoomStreamEventToManagedAgent(worker, event);
}

export function shouldDeliverCodexRoomStreamEventToManagedAgent(
  worker: DesktopManagedAgentSession,
  event: Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>,
): boolean {
  return resolveCodexRoomStreamEventRecipients([worker], event).length === 1;
}

/**
 * Resolve one room event against the complete eligible Codex population.
 * Alias uniqueness cannot be decided by an individual worker, so production
 * dispatch must call this once for the room rather than once per session.
 */
export function resolveCodexRoomStreamEventRecipients(
  workers: readonly DesktopManagedAgentSession[],
  event: Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>,
): DesktopManagedAgentSession[] {
  const eligible = workers.filter((worker) =>
    canDeliverDesktopEventToManagedAgent(worker) &&
    !isOwnRoomStreamEventForManagedAgent(worker, event));
  if (event.type === "task_update") {
    return eligible.filter((worker) => taskTargetsManagedAgent(worker, event.task));
  }
  return resolveCodexMessageRecipients(eligible, event.message);
}

export function shouldDeliverRoomStreamEventToManagedAgent(
  worker: DesktopManagedAgentSession,
  event: Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>,
): boolean {
  const canReceiveOrQueue = worker.deliveryMode === "desktop_events" &&
    Boolean(worker.agentSessionId) &&
    worker.status !== "interrupted" &&
    worker.status !== "failed";
  if (!canReceiveOrQueue || isOwnRoomStreamEventForManagedAgent(worker, event)) {
    return false;
  }

  if (event.type === "message") {
    return desktopManagedAgentMessageActivationDecision(worker, event.message) !== "silent";
  }

  const workerKeys = [
    worker.agentSessionId,
    specificAgentKey(worker.agentKey),
    worker.actorLabel,
    worker.displayName,
  ].map(normalizeKey).filter(Boolean);
  const taskTargetKeys = [
    specificAgentKey(event.task.assigneeAgentKey),
    event.task.assignee,
    ...event.task.activeLeases
      .filter((lease) => lease.status === "active")
      .flatMap((lease) => [lease.agentSessionId, specificAgentKey(lease.agentKey), lease.holderLabel]),
  ].map(normalizeKey).filter(Boolean);

  return !taskTargetKeys.length || workerKeys.some((key) => taskTargetKeys.includes(key));
}

export type DesktopManagedAgentMessageActivationDecision = "activate" | "silent" | "unclear";

/** The deterministic activation rule for Codex room workers. */
export function codexManagedAgentMessageActivationDecision(
  worker: Pick<DesktopManagedAgentSession, "agentSessionId" | "agentKey" | "actorLabel" | "displayName">,
  message: DesktopRoomMessage,
): DesktopManagedAgentMessageActivationDecision {
  return resolveCodexMessageRecipients([worker], message).length
    ? "activate"
    : "silent";
}

export function desktopManagedAgentMessageActivationDecision(
  worker: Pick<DesktopManagedAgentSession, "agentKey" | "actorLabel" | "displayName">,
  message: DesktopRoomMessage,
): DesktopManagedAgentMessageActivationDecision {
  if (normalizeKey(message.source) === "managed_agent_failure") {
    return "silent";
  }
  const mentions = extractMentionHandles(message.text);
  if (mentions.some(isBroadcastHandle)) {
    return "activate";
  }
  if (mentions.some((mention) => managedAgentAliases(worker).has(normalizeMentionIdentityHandle(mention)))) {
    return "activate";
  }
  if (hasBroadcastAddress(message.text)) {
    return "activate";
  }
  if (mentions.some(isLikelyAgentMentionHandle)) {
    return "silent";
  }

  if (senderMatchesManagedAgent(message.replyTo?.sender, worker)) {
    return "activate";
  }

  if (isAgentReplyTarget(message.replyTo) && !isThreadReply(message)) {
    return "silent";
  }

  if (isThreadReply(message) && threadParticipantsIncludeManagedAgent(message, worker)) {
    return "activate";
  }

  return "unclear";
}

export function isStopPhraseRoomStreamEvent(
  session: { stop_phrase: string },
  event: Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>,
): boolean {
  return event.type === "message" && event.message.text === session.stop_phrase;
}

const NON_AGENT_AT_HANDLES = new Set([
  "charset",
  "container",
  "counter-style",
  "font-face",
  "font-feature-values",
  "font-palette-values",
  "import",
  "keyframes",
  "layer",
  "media",
  "namespace",
  "page",
  "package",
  "property",
  "scope",
  "starting-style",
  "supports",
  "types",
  "viewport",
]);

function normalizeKey(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function specificAgentKey(value: string | null | undefined): string {
  const normalized = normalizeKey(value);
  if (!normalized || !/[/:]/.test(normalized)) {
    return "";
  }
  return normalized;
}

function isThreadReply(message: DesktopRoomMessage): boolean {
  const ownId = normalizeKey(message.id);
  const rootId = normalizeKey(message.threadRootId || message.thread?.rootMessageId);
  return Boolean(ownId && rootId && ownId !== rootId);
}

function isAgentReplyTarget(replyTo: DesktopRoomMessage["replyTo"]): boolean {
  return normalizeKey(replyTo?.source) === "agent";
}

function threadParticipantsIncludeManagedAgent(
  message: DesktopRoomMessage,
  worker: Pick<DesktopManagedAgentSession, "agentKey" | "actorLabel" | "displayName">,
): boolean {
  const senders = [
    message.replyTo?.sender,
    message.thread?.latestReply?.sender,
    ...(message.thread?.participants ?? []).map((participant) => participant.sender),
  ];

  return senders.some((sender) => senderMatchesManagedAgent(sender, worker));
}

function senderMatchesManagedAgent(
  sender: string | null | undefined,
  worker: Pick<DesktopManagedAgentSession, "agentKey" | "actorLabel" | "displayName">,
): boolean {
  const normalizedSender = normalizeKey(sender);
  if (!normalizedSender) {
    return false;
  }

  const aliases = managedAgentAliases(worker);
  if (aliases.has(normalizedSender)) {
    return true;
  }

  return String(sender || "")
    .split("|")
    .some((part) => aliases.has(normalizeKey(part)));
}

function managedAgentAliases(
  worker: Pick<DesktopManagedAgentSession, "agentKey" | "actorLabel" | "displayName"> &
    Partial<Pick<DesktopManagedAgentSession, "agentSessionId">>,
): Set<string> {
  const aliases = new Set<string>();
  for (const value of [
    worker.agentSessionId,
    worker.actorLabel,
    worker.displayName,
    worker.agentKey,
    worker.agentKey?.split("/").pop(),
  ]) {
    const keyAlias = normalizeKey(value);
    if (keyAlias) aliases.add(keyAlias);
    const handleAlias = normalizeHandle(value);
    if (handleAlias) aliases.add(handleAlias);
  }
  return aliases;
}

type CodexAddressableWorker = Pick<
  DesktopManagedAgentSession,
  "agentSessionId" | "agentKey" | "actorLabel" | "displayName"
>;

function resolveCodexMessageRecipients<T extends CodexAddressableWorker>(
  workers: readonly T[],
  message: DesktopRoomMessage,
): T[] {
  if (normalizeKey(message.source) === "managed_agent_failure") {
    return [];
  }

  const mentions = extractMentionHandles(message.text);
  if (mentions.some((mention) => normalizeHandle(mention) === "everyone")) {
    return [...workers];
  }

  const addressed = new Set<T>();
  let hasAgentMention = false;
  for (const mention of mentions) {
    if (!isLikelyAgentMentionHandle(mention)) continue;
    hasAgentMention = true;
    const normalizedMention = normalizeMentionIdentityHandle(mention);
    const stableMatches = workers.filter((worker) =>
      stableManagedAgentAliases(worker).has(normalizedMention));
    if (stableMatches.length === 1) {
      addressed.add(stableMatches[0]);
      continue;
    }
    // Stable identifiers are expected to be unique. Fail closed if corrupted
    // room state presents the same canonical identity more than once.
    if (stableMatches.length > 1) continue;

    const aliasMatches = workers.filter((worker) =>
      displayManagedAgentAliases(worker).has(normalizedMention));
    if (aliasMatches.length === 1) {
      addressed.add(aliasMatches[0]);
    }
  }
  if (hasAgentMention) {
    return workers.filter((worker) => addressed.has(worker));
  }

  return workers.filter((worker) =>
    senderMatchesManagedAgent(message.replyTo?.sender, worker) ||
    (isThreadReply(message) && threadParticipantsIncludeManagedAgent(message, worker)));
}

function stableManagedAgentAliases(worker: CodexAddressableWorker): Set<string> {
  const aliases = new Set<string>();
  const agentSessionId = normalizeHandle(worker.agentSessionId);
  const agentKey = normalizeHandle(specificAgentKey(worker.agentKey));
  if (agentSessionId) aliases.add(agentSessionId);
  if (agentKey) aliases.add(agentKey);
  return aliases;
}

function displayManagedAgentAliases(worker: CodexAddressableWorker): Set<string> {
  const aliases = new Set<string>();
  for (const value of [worker.displayName, worker.actorLabel]) {
    const alias = normalizeHandle(value);
    if (alias) aliases.add(alias);
  }
  return aliases;
}

function taskTargetsManagedAgent(
  worker: Pick<DesktopManagedAgentSession, "agentSessionId" | "agentKey" | "actorLabel" | "displayName">,
  task: Extract<DesktopRoomStreamEvent, { type: "task_update" }>['task'],
): boolean {
  const workerKeys = [
    worker.agentSessionId,
    specificAgentKey(worker.agentKey),
    worker.actorLabel,
    worker.displayName,
  ].map(normalizeKey).filter(Boolean);
  const taskTargetKeys = [
    specificAgentKey(task.assigneeAgentKey),
    task.assignee,
    ...task.activeLeases
      .filter((lease) => lease.status === "active")
      .flatMap((lease) => [lease.agentSessionId, specificAgentKey(lease.agentKey), lease.holderLabel]),
  ].map(normalizeKey).filter(Boolean);

  return taskTargetKeys.length > 0 && workerKeys.some((key) => taskTargetKeys.includes(key));
}

function extractMentionHandles(text: string | null | undefined): string[] {
  const raw = typeof text === "string" ? text : "";
  const mentions: string[] = [];
  for (const match of raw.matchAll(/(^|[\s([{:;,])@([A-Za-z0-9][A-Za-z0-9_.:-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*)/g)) {
    mentions.push(match[2]);
  }
  return mentions;
}

function isBroadcastHandle(handle: string): boolean {
  const normalized = normalizeHandle(handle);
  return normalized === "agents" || normalized === "everyone" || normalized === "room";
}

function isLikelyAgentMentionHandle(handle: string): boolean {
  const raw = String(handle || "").trim();
  if (!raw) return false;
  const normalized = raw.toLowerCase();
  const firstSegment = normalized.split("/", 1)[0].replace(/_/g, "-");
  if (normalized.startsWith("agent:")) return true;
  if (normalized.includes("/") && normalized === raw) return false;
  return !NON_AGENT_AT_HANDLES.has(firstSegment);
}

function hasBroadcastAddress(text: string | null | undefined): boolean {
  const raw = typeof text === "string" ? text.toLowerCase() : "";
  return /\b(everyone|all agents|you guys|both of you|any agent|whoever owns this)\b/.test(raw);
}

function normalizeHandle(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.:/-]+/g, "");
}

function normalizeMentionIdentityHandle(value: string | null | undefined): string {
  const normalized = normalizeHandle(value);
  return normalized.startsWith("agent:") ? normalized.slice("agent:".length) : normalized;
}

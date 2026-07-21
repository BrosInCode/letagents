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

/**
 * The single-worker helper above is useful at older call sites, but it cannot
 * safely decide a display-name match when a room has two workers named Oak.
 * Production Codex routing therefore resolves authorship against the room
 * population: stable identities are exact; a name is self only when it has
 * one possible owner.
 */
export function isOwnRoomStreamEventForManagedAgentAmongWorkers(
  worker: Pick<DesktopManagedAgentSession, "agentSessionId" | "agentKey" | "actorLabel" | "displayName">,
  workers: readonly Pick<DesktopManagedAgentSession, "agentSessionId" | "agentKey" | "actorLabel" | "displayName">[],
  event: Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>,
): boolean {
  if (event.type !== "message") return false;
  return resolveMessageAuthorWorkers(workers, event.message).some((candidate) =>
    sameManagedAgentIdentity(candidate, worker));
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
  const deliverable = workers.filter(canDeliverDesktopEventToManagedAgent);
  const ownWorkers = event.type === "message"
    ? new Set(resolveMessageAuthorWorkers(deliverable, event.message))
    : new Set<DesktopManagedAgentSession>();
  const eligible = deliverable.filter((worker) => !ownWorkers.has(worker));
  if (event.type === "task_update") {
    return resolveCodexTaskRecipients(eligible, event.task);
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
  if (mentions.some((mention) => normalizeMentionHandle(mention) === "everyone")) {
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

  return resolveThreadAndReplyRecipients(workers, message);
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

function resolveCodexTaskRecipients<T extends CodexAddressableWorker>(
  workers: readonly T[],
  task: Extract<DesktopRoomStreamEvent, { type: "task_update" }>['task'],
): T[] {
  // A durable assignment or lease identity is authoritative. In particular,
  // a human-facing assignee label must never widen an exact assignment to a
  // second worker which happens to share a display name.
  const stableTargets = [
    specificAgentKey(task.assigneeAgentKey),
    ...task.activeLeases
      .filter((lease) => lease.status === "active")
      .flatMap((lease) => [lease.agentSessionId, specificAgentKey(lease.agentKey)]),
  ].map(normalizeHandle).filter(Boolean);
  if (stableTargets.length) {
    const owner = resolveConvergentStableWorker(workers, stableTargets);
    return owner ? [owner] : [];
  }

  const aliasTargets = [
    task.assignee,
    ...task.activeLeases
      .filter((lease) => lease.status === "active")
      .map((lease) => lease.holderLabel),
  ];
  return resolveUniqueAliasRecipients(workers, aliasTargets);
}

function resolveThreadAndReplyRecipients<T extends CodexAddressableWorker>(
  workers: readonly T[],
  message: DesktopRoomMessage,
): T[] {
  const senders = [
    message.replyTo?.sender,
    ...(isThreadReply(message)
      ? [
        message.thread?.latestReply?.sender,
        ...(message.thread?.participants ?? []).map((participant) => participant.sender),
      ]
      : []),
  ];
  return resolveUniqueAliasRecipients(workers, senders);
}

/** Resolve aliases globally. A duplicate display alias is deliberately a no-op. */
function resolveUniqueAliasRecipients<T extends CodexAddressableWorker>(
  workers: readonly T[],
  aliases: readonly (string | null | undefined)[],
): T[] {
  const recipients = new Set<T>();
  for (const alias of aliases) {
    const fullAlias = String(alias || "").trim();
    if (!fullAlias) continue;

    const fullMatch = resolveExactAliasWorker(workers, fullAlias);
    if (fullMatch.kind === "unique") {
      recipients.add(fullMatch.worker);
      continue;
    }
    // A full alias that is itself ambiguous is not made safer by splitting it.
    if (fullMatch.kind === "ambiguous" || !fullAlias.includes("|")) continue;

    const fallback = new Set<T>();
    let ambiguous = false;
    for (const candidate of identityParts(fullAlias)) {
      const match = resolveExactAliasWorker(workers, candidate);
      if (match.kind === "ambiguous") {
        ambiguous = true;
        break;
      }
      if (match.kind === "unique") fallback.add(match.worker);
    }
    if (!ambiguous && fallback.size === 1) recipients.add([...fallback][0]!);
  }
  return workers.filter((worker) => recipients.has(worker));
}

function resolveExactAliasWorker<T extends CodexAddressableWorker>(
  workers: readonly T[],
  alias: string,
): { kind: "none" } | { kind: "ambiguous" } | { kind: "unique"; worker: T } {
  const normalized = normalizeHandle(alias);
  const stableMatches = workers.filter((worker) => stableManagedAgentAliases(worker).has(normalized));
  if (stableMatches.length === 1) return { kind: "unique", worker: stableMatches[0]! };
  if (stableMatches.length > 1) return { kind: "ambiguous" };
  const displayMatches = workers.filter((worker) => displayManagedAgentAliases(worker).has(normalized));
  if (displayMatches.length === 1) return { kind: "unique", worker: displayMatches[0]! };
  return displayMatches.length > 1 ? { kind: "ambiguous" } : { kind: "none" };
}

function resolveMessageAuthorWorkers<T extends CodexAddressableWorker>(
  workers: readonly T[],
  message: DesktopRoomMessage,
): T[] {
  const stableIds = [
    message.agentIdentity?.agentSessionId,
    specificAgentKey(message.agentIdentity?.agentKey),
  ].map(normalizeHandle).filter(Boolean);
  if (stableIds.length) {
    const author = resolveConvergentStableWorker(workers, stableIds);
    return author ? [author] : [];
  }

  if (normalizeKey(message.source) !== "agent") return [];

  // Keep only unique name resolutions. An identityless "Oak" from a room
  // containing two Oakes is not self-output for either worker, especially for
  // broadcasts: both must still receive @everyone.
  const candidates = resolveUniqueAliasRecipients(workers, [
    message.actorLabel,
    message.agentIdentity?.actorLabel,
    message.agentIdentity?.displayName,
    message.sender,
  ]);
  return candidates.length === 1 ? candidates : [];
}

function resolveConvergentStableWorker<T extends CodexAddressableWorker>(
  workers: readonly T[],
  stableIds: readonly string[],
): T | null {
  const matches = stableIds.map((identity) => workers.filter((worker) =>
    stableManagedAgentAliases(worker).has(identity)));
  const [first, ...rest] = matches;
  if (!first || first.length !== 1 || rest.some((entry) =>
    entry.length !== 1 || !sameManagedAgentIdentity(entry[0], first[0]))) {
    return null;
  }
  return first[0];
}

function sameManagedAgentIdentity(
  left: CodexAddressableWorker,
  right: CodexAddressableWorker,
): boolean {
  const leftSession = normalizeHandle(left.agentSessionId);
  const rightSession = normalizeHandle(right.agentSessionId);
  if (leftSession && rightSession) return leftSession === rightSession;
  const leftKey = normalizeHandle(specificAgentKey(left.agentKey));
  const rightKey = normalizeHandle(specificAgentKey(right.agentKey));
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function identityParts(value: string | null | undefined): string[] {
  const raw = String(value || "").trim();
  return [raw, ...raw
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)]
    .filter((part, index, values) => Boolean(part) && values.indexOf(part) === index);
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
  const normalized = normalizeMentionHandle(handle);
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
  const normalized = normalizeMentionHandle(value);
  return normalized.startsWith("agent:") ? normalized.slice("agent:".length) : normalized;
}

function normalizeMentionHandle(value: string | null | undefined): string {
  // The tokenizer intentionally accepts dots and colons inside handles. Trim
  // them only when they are sentence punctuation at the end of the mention:
  // `@DawnRidge.`, `@agent_session_dawn:`, and `@agent:key.` all retain their
  // meaningful internal punctuation while resolving normally.
  return normalizeHandle(value).replace(/[.,!?;:]+$/g, "");
}

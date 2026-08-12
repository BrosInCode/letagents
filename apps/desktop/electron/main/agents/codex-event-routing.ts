import type {
  DesktopManagedAgentSession,
  DesktopRoomMessage,
  DesktopRoomStreamEvent,
} from "../../ipc-types.js";
import {
  normalizeRoutingHandle,
  normalizeRoutingSender,
  routingIdentityAliases,
  routingSenderAliasRows,
} from "../../../../../shared/routing-aliases.mjs";
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
  populationComplete = true,
): DesktopManagedAgentSession[] {
  const deliverable = workers.filter(canDeliverDesktopEventToManagedAgent);
  const ownWorkers = event.type === "message"
    ? new Set(resolveMessageAuthorWorkers(deliverable, event.message))
    : new Set<DesktopManagedAgentSession>();
  const eligible = deliverable.filter((worker) => !ownWorkers.has(worker));
  if (!populationComplete && !hasExactSessionRoutingAuthority(event)) {
    return [];
  }
  if (event.type === "task_update") {
    return resolveEligibleTaskRecipients(workers, eligible, event.task, false);
  }
  return resolveCodexMessageRecipients(eligible, event.message);
}

export function shouldDeliverRoomStreamEventToManagedAgent(
  worker: DesktopManagedAgentSession,
  event: Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>,
): boolean {
  return resolveDesktopRoomStreamEventRecipients([worker], event).length === 1;
}

/** Resolve provider-neutral desktop recipients with durable-key uniqueness. */
export function resolveDesktopRoomStreamEventRecipients(
  workers: readonly DesktopManagedAgentSession[],
  event: Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>,
  populationComplete = true,
): DesktopManagedAgentSession[] {
  const eligible = workers.filter((worker) =>
    worker.deliveryMode === "desktop_events"
    && Boolean(worker.agentSessionId)
    && worker.status !== "interrupted"
    && worker.status !== "failed"
    && !isOwnRoomStreamEventForManagedAgentAmongWorkers(worker, workers, event));
  if (!populationComplete && !hasExactSessionRoutingAuthority(event)) {
    return [];
  }
  if (event.type === "task_update") {
    return resolveEligibleTaskRecipients(workers, eligible, event.task, true);
  }
  const routing = event.message.accountAgentRouting;
  if (routing?.authority === "invalid") return [];
  if (routing?.authority === "receipts") {
    return resolveReceiptWorkers(eligible, routing);
  }
  if (routing?.authority === "legacy") {
    return resolveLegacyWorkers(eligible, routing);
  }
  return resolveProviderNeutralLegacyMessageRecipients(eligible, event.message);
}

function resolveProviderNeutralLegacyMessageRecipients<T extends CodexAddressableWorker>(
  workers: readonly T[],
  message: DesktopRoomMessage,
): T[] {
  if (normalizeKey(message.source) === "managed_agent_failure") return [];
  const mentions = extractMentionHandles(message.text);
  if (mentions.some(isBroadcastHandle) || hasBroadcastAddress(message.text)) {
    return [...workers];
  }
  if (mentions.some(isLikelyAgentMentionHandle)) {
    return resolveCodexMessageRecipients(workers, message);
  }
  if (isThreadReply(message) || isAgentReplyTarget(message.replyTo)) {
    return resolveThreadAndReplyRecipients(workers, message);
  }
  return [...workers];
}

function hasExactSessionRoutingAuthority(
  event: Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>,
): boolean {
  if (event.type !== "message") return false;
  const routing = event.message.accountAgentRouting;
  return Boolean(
    routing
    && routing.authority !== "invalid"
    && "recipientSessions" in routing
    && Array.isArray(routing.recipientSessions),
  );
}

/**
 * Turn local SQLite routing facts into the same exact-session authority that
 * cloud desktop overlays carry. Alias resolution runs against the complete
 * cross-provider population; rotation overlap is then collapsed to one
 * deterministic live representative per durable key.
 */
export type LocalRoutingAuthorityWorker = Pick<
  DesktopManagedAgentSession,
  "id" | "agentSessionId" | "agentKey" | "actorLabel" | "displayName" | "startedAt"
>;

export function buildLocalLegacyAccountAgentRouting(
  workers: readonly DesktopManagedAgentSession[],
  message: DesktopRoomMessage,
  threadParticipantAgentKeys: readonly string[] = [],
  authorityWorkers?: readonly LocalRoutingAuthorityWorker[],
): Extract<NonNullable<DesktopRoomMessage["accountAgentRouting"]>, { authority: "legacy" }> {
  const deliverable = workers.filter(canDeliverDesktopEventToManagedAgent);
  const completePopulation = authorityWorkers ?? deliverable;
  const representativeByKey = new Map<string, LocalRoutingAuthorityWorker>();
  const keysByAlias = new Map<string, Set<string>>();
  for (const worker of [...completePopulation].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id))) {
    const key = normalizeKey(specificAgentKey(worker.agentKey));
    if (!key) continue;
    if (!representativeByKey.has(key)) representativeByKey.set(key, worker);
    for (const alias of routingIdentityAliases(worker)) {
      const keys = keysByAlias.get(alias) ?? new Set<string>();
      keys.add(key);
      keysByAlias.set(alias, keys);
    }
  }

  const uniquelyMatchedSenderKeys = (sender: string | null | undefined): Set<string> => {
    const rows = routingSenderAliasRows(sender);
    const matches = (full: boolean) => {
      const keys = new Set<string>();
      for (const row of rows) {
        if (row.isFull !== full) continue;
        for (const key of keysByAlias.get(row.alias) ?? []) keys.add(key);
      }
      return keys;
    };
    const full = matches(true);
    const selected = full.size > 0 ? full : matches(false);
    return selected.size === 1 ? selected : new Set<string>();
  };

  const selfKeys = new Set<string>();
  if (normalizeKey(message.source) === "agent") {
    const publisherKey = normalizeKey(specificAgentKey(message.agentIdentity?.agentKey));
    if (publisherKey) {
      selfKeys.add(publisherKey);
    } else {
      // Pre-authority local rows cannot distinguish an agent author from a
      // same-named recipient. Replaying those rows through current workers is
      // unsafe (and can self-reactivate a restarted worker), so exact local
      // routing fails closed until a durable publisher identity is present.
      return {
        version: 1,
        authority: "legacy",
        recipientAgentKeys: [],
        recipientSessions: [],
        controlAuthorized: false,
      };
    }
  }

  let addressedKeys = new Set<string>();
  const exactRecipientSessionByKey = new Map<string, string>();
  const mentions = extractMentionHandles(message.text);
  if (mentions.some(isBroadcastHandle) || hasBroadcastAddress(message.text)) {
    addressedKeys = new Set(representativeByKey.keys());
  } else if (mentions.some(isLikelyAgentMentionHandle)) {
    for (const mention of mentions) {
      if (!isLikelyAgentMentionHandle(mention) || isBroadcastHandle(mention)) continue;
      const matches = keysByAlias.get(normalizeMentionIdentityHandle(mention));
      if (matches?.size === 1) addressedKeys.add(matches.values().next().value!);
    }
  } else if (isThreadReply(message)) {
    addressedKeys = new Set(threadParticipantAgentKeys
      .map((key) => normalizeKey(specificAgentKey(key)))
      .filter((key) => Boolean(key) && representativeByKey.has(key)));
  } else {
    const replyPublisherKey = normalizeKey(specificAgentKey(message.replyTo?.agentIdentity?.agentKey));
    const replyPublisherSessionId = normalizeKey(message.replyTo?.agentIdentity?.agentSessionId);
    if (replyPublisherKey && representativeByKey.has(replyPublisherKey)) {
      addressedKeys.add(replyPublisherKey);
      if (
        replyPublisherSessionId
        && completePopulation.some((worker) =>
          normalizeKey(specificAgentKey(worker.agentKey)) === replyPublisherKey
          && normalizeKey(worker.agentSessionId) === replyPublisherSessionId)
      ) {
        exactRecipientSessionByKey.set(replyPublisherKey, replyPublisherSessionId);
      }
    } else if (normalizeKey(message.replyTo?.source) === "agent") {
      addressedKeys = uniquelyMatchedSenderKeys(message.replyTo?.sender);
    }
  }
  for (const key of selfKeys) addressedKeys.delete(key);

  const recipientSessions = [...addressedKeys].sort().flatMap((agentKey) => {
    const representative = representativeByKey.get(agentKey);
    const agentSessionId = exactRecipientSessionByKey.get(agentKey)
      ?? representative?.agentSessionId;
    return representative && agentSessionId
      ? [{
          agentKey,
          agentSessionId,
          activationReason: "local_legacy",
        }]
      : [];
  });
  return {
    version: 1,
    authority: "legacy",
    recipientAgentKeys: recipientSessions.map((target) => target.agentKey),
    recipientSessions,
    controlAuthorized: message.localControlAuthorized
      ?? message.source === "browser",
  };
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
  worker: Pick<DesktopManagedAgentSession, "agentSessionId" | "agentKey" | "actorLabel" | "displayName">,
  message: DesktopRoomMessage,
): DesktopManagedAgentMessageActivationDecision {
  if (normalizeKey(message.source) === "managed_agent_failure") {
    return "silent";
  }
  const routing = message.accountAgentRouting;
  if (routing?.authority === "invalid") return "silent";
  if (routing?.authority === "receipts") {
    const sessionId = normalizeKey(worker.agentSessionId);
    const durableKey = normalizeKey(specificAgentKey(worker.agentKey));
    return sessionId && durableKey && routing.recipientSessions.some((target) =>
      normalizeKey(target.agentKey) === durableKey
      && (
        normalizeKey(target.agentSessionId) === sessionId
        || normalizeKey(target.successorAgentSessionId) === sessionId
      ))
      ? "activate"
      : "silent";
  }
  if (routing?.authority === "legacy") {
    const sessionId = normalizeKey(worker.agentSessionId);
    const durableKey = normalizeKey(specificAgentKey(worker.agentKey));
    return sessionId && durableKey && routing.recipientSessions.some((target) =>
      normalizeKey(target.agentKey) === durableKey
      && normalizeKey(target.agentSessionId) === sessionId)
      ? "activate"
      : "silent";
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

  if (isAgentReplyTarget(message.replyTo) && senderMatchesManagedAgent(message.replyTo?.sender, worker)) {
    return "activate";
  }

  if (isAgentReplyTarget(message.replyTo) && !isThreadReply(message)) {
    return "silent";
  }

  if (
    isThreadReply(message)
    && threadParticipantsIncludeManagedAgent(message, worker)
  ) {
    return "activate";
  }

  return "unclear";
}

export function isStopPhraseRoomStreamEvent(
  session: { stop_phrase?: string | null; stopPhrase?: string | null },
  event: Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>,
): boolean {
  const stopPhrase = session.stop_phrase ?? session.stopPhrase;
  return event.type === "message"
    && event.message.accountAgentRouting?.authority !== "invalid"
    && event.message.accountAgentRouting?.controlAuthorized === true
    && Boolean(stopPhrase)
    && event.message.text === stopPhrase;
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
  return normalizeRoutingSender(value);
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
    normalizeKey(message.replyTo?.source) === "agent" ? message.replyTo?.sender : null,
    normalizeKey(message.thread?.latestReply?.source) === "browser"
      ? null
      : message.thread?.latestReply?.sender,
    ...(message.thread?.participants ?? []).map((participant) =>
      normalizeKey(participant.source) === "browser" ? null : participant.sender),
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

  const routing = message.accountAgentRouting;
  if (routing?.authority === "invalid") return [];
  if (routing?.authority === "receipts") {
    return resolveReceiptWorkers(workers, routing);
  }
  if (routing?.authority === "legacy") {
    return resolveLegacyWorkers(workers, routing);
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

  const recipients = new Set(resolveThreadAndReplyRecipients(workers, message));
  return workers.filter((worker) => recipients.has(worker));
}

function resolveReceiptWorkers<T extends CodexAddressableWorker>(
  workers: readonly T[],
  routing: Extract<NonNullable<DesktopRoomMessage["accountAgentRouting"]>, { authority: "receipts" }>,
): T[] {
  const requestedKeys = new Set(routing.recipientAgentKeys.map(normalizeKey).filter(Boolean));
  const deliverySessionsByKey = new Map<string, Set<string>>();
  for (const target of routing.recipientSessions) {
    const key = normalizeKey(specificAgentKey(target.agentKey));
    const sessionId = normalizeKey(
      target.successorAgentSessionId ?? target.agentSessionId,
    );
    if (!key || !sessionId || !requestedKeys.has(key)) continue;
    const sessions = deliverySessionsByKey.get(key) ?? new Set<string>();
    sessions.add(sessionId);
    deliverySessionsByKey.set(key, sessions);
  }

  const selected: T[] = [];
  for (const key of requestedKeys) {
    const exactSessionIds = deliverySessionsByKey.get(key);
    if (!exactSessionIds?.size) continue;
    const exactMatches = workers.filter((worker) =>
      normalizeKey(specificAgentKey(worker.agentKey)) === key
      && exactSessionIds.has(normalizeKey(worker.agentSessionId)));
    if (exactMatches.length === 1) selected.push(exactMatches[0]!);
    // Duplicate exact-session state is corrupt and remains fail-closed.
  }
  return selected;
}

function resolveLegacyWorkers<T extends CodexAddressableWorker>(
  workers: readonly T[],
  routing: Extract<NonNullable<DesktopRoomMessage["accountAgentRouting"]>, { authority: "legacy" }>,
): T[] {
  const selected: T[] = [];
  for (const target of routing.recipientSessions) {
    const key = normalizeKey(target.agentKey);
    const sessionId = normalizeKey(target.agentSessionId);
    const matches = workers.filter((worker) =>
      normalizeKey(specificAgentKey(worker.agentKey)) === key
      && normalizeKey(worker.agentSessionId) === sessionId);
    if (matches.length === 1) selected.push(matches[0]!);
  }
  return selected;
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

function resolveEligibleTaskRecipients<T extends CodexAddressableWorker>(
  workers: readonly T[],
  eligible: readonly T[],
  task: Extract<DesktopRoomStreamEvent, { type: "task_update" }>['task'],
  includeUntargeted: boolean,
): T[] {
  // Identity ambiguity is a room-global property. Resolve before applying a
  // runtime's eligibility filter so another provider or a stale local worker
  // cannot disappear from duplicate-session/key checks.
  const eligibleWorkers = new Set(eligible);
  return resolveTaskRecipients(workers, task, includeUntargeted)
    .filter((worker) => eligibleWorkers.has(worker));
}

function resolveTaskRecipients<T extends CodexAddressableWorker>(
  workers: readonly T[],
  task: Extract<DesktopRoomStreamEvent, { type: "task_update" }>['task'],
  includeUntargeted: boolean,
): T[] {
  const recipients = new Set<T>();
  const activeLeases = task.activeLeases.filter((lease) => lease.status === "active");
  const workLeases = activeLeases.filter((lease) => lease.kind === "work");
  if (
    includeUntargeted
    &&
    activeLeases.length === 0
    && !String(task.assigneeAgentKey ?? "").trim()
    && !String(task.assignee ?? "").trim()
  ) {
    return [...workers];
  }

  // At most one active work lease is valid for a task. Its exact session is
  // newer authority than the durable key, so a supported old/new overlap may
  // share that key without waking both workers. The task assignment and lease
  // key still have to agree with the exact worker when they are present.
  if (workLeases.length === 1) {
    const workOwner = resolveTaskTargetWorker(workers, {
      agentSessionId: workLeases[0]!.agentSessionId,
      agentKeys: [task.assigneeAgentKey, workLeases[0]!.agentKey],
      aliases: [task.assignee, workLeases[0]!.holderLabel],
    });
    if (workOwner) recipients.add(workOwner);
  } else if (workLeases.length === 0) {
    const assignee = resolveTaskTargetWorker(workers, {
      agentSessionId: null,
      agentKeys: [task.assigneeAgentKey],
      aliases: [task.assignee],
    });
    if (assignee) recipients.add(assignee);
  }

  // Review leases are independent authorities and may legitimately coexist
  // with the work lease. Resolve each tuple independently, then deduplicate a
  // worker which happens to hold more than one lease.
  for (const lease of activeLeases) {
    if (lease.kind === "work") continue;
    const owner = resolveTaskTargetWorker(workers, {
      agentSessionId: lease.agentSessionId,
      agentKeys: [lease.agentKey],
      aliases: [lease.holderLabel],
    });
    if (owner) recipients.add(owner);
  }

  return workers.filter((worker) => recipients.has(worker));
}

function resolveTaskTargetWorker<T extends CodexAddressableWorker>(
  workers: readonly T[],
  target: {
    agentSessionId: string | null | undefined;
    agentKeys: readonly (string | null | undefined)[];
    aliases: readonly (string | null | undefined)[];
  },
): T | null {
  const exactSessionId = normalizeHandle(target.agentSessionId);
  const hasSuppliedSessionId = Boolean(String(target.agentSessionId ?? "").trim());
  const agentKeys = normalizeSuppliedAgentKeys(target.agentKeys);
  if (agentKeys === null || (hasSuppliedSessionId && !exactSessionId)) return null;

  if (exactSessionId) {
    const exactMatches = workers.filter((worker) =>
      normalizeHandle(worker.agentSessionId) === exactSessionId);
    if (exactMatches.length !== 1) return null;

    const exactWorker = exactMatches[0]!;
    const workerKey = normalizeHandle(specificAgentKey(exactWorker.agentKey));
    return agentKeys.every((key) => workerKey === key) ? exactWorker : null;
  }

  if (agentKeys.length) {
    const keyMatches = workers.filter((worker) => {
      const workerKey = normalizeHandle(specificAgentKey(worker.agentKey));
      return agentKeys.every((key) => workerKey === key);
    });
    return keyMatches.length === 1 ? keyMatches[0]! : null;
  }

  const aliasMatches = resolveUniqueAliasRecipients(workers, target.aliases);
  return aliasMatches.length === 1 ? aliasMatches[0]! : null;
}

function normalizeSuppliedAgentKeys(
  values: readonly (string | null | undefined)[],
): string[] | null {
  const normalized = new Set<string>();
  for (const value of values) {
    if (!String(value ?? "").trim()) continue;
    const key = normalizeHandle(specificAgentKey(value));
    if (!key) return null;
    normalized.add(key);
  }
  return [...normalized];
}

function resolveThreadAndReplyRecipients<T extends CodexAddressableWorker>(
  workers: readonly T[],
  message: DesktopRoomMessage,
  includeDisplayThreadParticipants = true,
): T[] {
  const senders = [
    normalizeKey(message.replyTo?.source) === "agent" ? message.replyTo?.sender : null,
    ...(includeDisplayThreadParticipants && isThreadReply(message)
      ? [
        normalizeKey(message.thread?.latestReply?.source) === "browser"
          ? null
          : message.thread?.latestReply?.sender,
        ...(message.thread?.participants ?? []).map((participant) =>
          normalizeKey(participant.source) === "browser" ? null : participant.sender),
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
  return normalizeRoutingHandle(value);
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

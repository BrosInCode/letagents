import {
  normalizeRoutingHandle,
  normalizeRoutingSender,
  routingIdentityAliases,
  routingSenderAliasRows,
  routingSenderAliases,
} from "../../shared/routing-aliases.mjs";
import { parsePositivePgIntegerScopedId } from "./scoped-ids.js";

export type AgentMessageActivationDecision = "activate" | "silent" | "unclear";

export type AgentMessageActivationReason =
  | "self_message"
  | "explicit_mention"
  | "explicit_other_mention"
  | "broadcast"
  | "reply_target"
  | "other_reply_target"
  | "thread_participant"
  | "task_owner"
  | "small_room"
  | "recent_conversation"
  | "system_event"
  | "unaddressed";

/** Send-time human fallback only; never use this to re-route historical reads. */
export function humanConversationFallback(input: {
  source: string | null; publisherAccountId: string | null; publisherAgentKey: string | null;
  explicitlyAddressed: boolean; registeredAgentKeys: readonly string[];
  recentAgentKey?: string | null;
}): { reason: "small_room" | "recent_conversation"; agentKeys: string[] } | null {
  if (input.source !== "browser" || !input.publisherAccountId || input.publisherAgentKey || input.explicitlyAddressed) return null;
  const keys = [...new Set(input.registeredAgentKeys)];
  if (keys.length > 0 && keys.length <= 2) return { reason: "small_room", agentKeys: keys };
  if (keys.length > 2 && input.recentAgentKey && keys.includes(input.recentAgentKey)) {
    return { reason: "recent_conversation", agentKeys: [input.recentAgentKey] };
  }
  return null;
}

/**
 * Repository events can contain text written by any external contributor.
 * They remain visible room activity, but their text is never an instruction
 * channel for a managed local worker.
 */
export function isUntrustedExternalActivationSource(source: unknown): boolean {
  return normalizeSender(source) === "github";
}

export interface AgentMessageActivation {
  for_current_agent: {
    decision: AgentMessageActivationDecision;
    reason: AgentMessageActivationReason;
    addressed: boolean;
  };
}

type MessageLike = {
  id?: unknown;
  sender?: unknown;
  text?: unknown;
  source?: unknown;
  thread_root_id?: unknown;
  thread?: {
    root_message_id?: unknown;
    participants?: Array<{ sender?: unknown }> | null;
    latest_reply?: { sender?: unknown } | null;
  } | null;
  reply_to?: { sender?: unknown; source?: unknown } | null;
};

export type ActivationIdentity = {
  actor_label: string;
  agent_key: string;
  agent_instance_id: string | null;
  agent_session_id: string | null;
  display_name: string;
  session_kind: string;
};

type ActivationTaskLeaseLike = {
  kind: string;
  status: string;
  actor_label: string;
  agent_key: string;
  agent_instance_id: string | null;
  agent_session_id: string | null;
};

export type AgentMessageActivationContext = {
  activeTaskLeases?: readonly ActivationTaskLeaseLike[];
  /** Legacy messages authored by this exact durable identity. */
  selfMessageIds?: ReadonlySet<string>;
  /** Thread roots whose routing projection contains this exact identity. */
  threadParticipantRootIds?: ReadonlySet<string>;
  /** Legacy messages whose globally resolved mention names this identity. */
  explicitMentionMessageIds?: ReadonlySet<string>;
  /** Legacy messages whose globally resolved reply target names this identity. */
  replyTargetMessageIds?: ReadonlySet<string>;
  /** Complete legacy decisions supplied by the room-global routing authority. */
  authoritativeLegacyDecisions?: ReadonlyMap<
    string,
    AgentMessageActivation["for_current_agent"]
  >;
};

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

const TASK_OWNER_FOLLOW_UP_PATTERNS = [
  /^(?:ok(?:ay)?|right|cool|great|nice)?[\s,]*(?:try again|retry|rerun|re-run|continue|proceed|go ahead|carry on)\b/,
  /^(?:ok(?:ay)?|right|cool|great|nice)?[\s,]*(?:open|create|make|raise)\s+(?:a\s+)?pr\b/,
  /^(?:ok(?:ay)?|right|cool|great|nice)?[\s,]*(?:push|merge|ship|fix|test|run|update)\s+(?:it|that|this|again|tests?|the\s+tests?|ci)\b/,
  /\b(?:try again|open\s+(?:a\s+)?pr|create\s+(?:a\s+)?pr|make\s+(?:a\s+)?pr|push it|merge it|update it)\b/,
];

export function attachAgentMessageActivation<T extends MessageLike>(
  message: T,
  identity: ActivationIdentity,
  context: AgentMessageActivationContext = {},
): T & { activation: AgentMessageActivation } {
  return {
    ...message,
    activation: {
      for_current_agent: decideAgentMessageActivation(message, identity, context),
    },
  };
}

/**
 * Send-time receipts are the activation authority. For a snapshot-bearing
 * message, a receipt activates and the absence of one is the durable
 * send-time "silent" — never re-promoted by re-running the router against
 * later task/thread/session state, which would create a second authority.
 * Only messages that predate routing snapshots keep the lazy per-reader
 * decision, so legacy backlog mentions still activate rotated sessions.
 */
export function attachAgentMessageActivationsFromReceipts<T extends MessageLike>(
  messages: readonly T[],
  identity: ActivationIdentity | null,
  receiptsMap: ReadonlyMap<number | string, { activation_reason: string }>,
  snapshotNumbers: ReadonlySet<number>,
  context: AgentMessageActivationContext = {},
): T[] | Array<T & { activation: AgentMessageActivation }> {
  if (!identity || identity.session_kind !== "worker") {
    return [...messages];
  }

  return messages.map((message) => {
    const msgIdStr = String(message.id ?? "");
    const msgNum = parsePositivePgIntegerScopedId(msgIdStr, "msg");
    const receipt = msgNum !== null ? receiptsMap.get(msgNum) || receiptsMap.get(msgIdStr) : null;

    if (receipt) {
      const reason = receipt.activation_reason as AgentMessageActivationReason;
      return {
        ...message,
        activation: {
          for_current_agent: {
            decision: "activate" as const,
            reason: reason || "explicit_mention",
            addressed: true,
          },
        },
      };
    }

    // System failure rows are canonical silent control events. A routing
    // snapshot with no receipt must not erase their diagnostic reason.
    if (
      msgNum !== null
      && snapshotNumbers.has(msgNum)
      && normalizeSender(message.source) !== "managed_agent_failure"
    ) {
      return {
        ...message,
        activation: {
          for_current_agent: {
            decision: "silent" as const,
            reason: "unaddressed" as const,
            addressed: false,
          },
        },
      };
    }

    return attachAgentMessageActivation(message, identity, context);
  });
}

export function attachAgentMessageActivations<T extends MessageLike>(
  messages: readonly T[],
  identity: ActivationIdentity | null,
  context: AgentMessageActivationContext = {},
): T[] | Array<T & { activation: AgentMessageActivation }> {
  if (!identity || identity.session_kind !== "worker") {
    return [...messages];
  }

  return messages.map((message) => attachAgentMessageActivation(message, identity, context));
}

export function decideAgentMessageActivation(
  message: MessageLike,
  identity: ActivationIdentity,
  context: AgentMessageActivationContext = {},
): AgentMessageActivation["for_current_agent"] {
  if (
    normalizeSender(message.source) === "managed_agent_failure"
    || isUntrustedExternalActivationSource(message.source)
  ) {
    return decision("silent", "system_event");
  }

  const messageId = normalizedString(message.id);
  const authoritativeLegacyDecision = context.authoritativeLegacyDecisions?.get(messageId);
  if (authoritativeLegacyDecision) return authoritativeLegacyDecision;

  if (
    context.selfMessageIds !== undefined
      ? context.selfMessageIds.has(messageId)
      : senderMatchesIdentity(message.sender, identity)
  ) {
    return decision("silent", "self_message");
  }

  const mentions = extractMentionHandles(message.text);
  if (mentions.some(isBroadcastHandle)) {
    return decision("activate", "broadcast");
  }
  const authoritativeExplicitMentions = context.explicitMentionMessageIds;
  if (
    authoritativeExplicitMentions !== undefined
      ? authoritativeExplicitMentions.has(messageId)
      : mentions.some((mention) => activationIdentityAliases(identity).has(normalizeMentionIdentityHandle(mention)))
  ) {
    return decision("activate", "explicit_mention");
  }
  if (hasBroadcastAddress(message.text)) {
    return decision("activate", "broadcast");
  }
  if (mentions.some(isLikelyAgentMentionHandle)) {
    return decision("silent", "explicit_other_mention");
  }

  const authoritativeThreadParticipantRootIds = context.threadParticipantRootIds;
  const authoritativeReplyTargets = context.replyTargetMessageIds;
  const hasAuthoritativeThreadMembership = isThreadReply(message)
    && authoritativeThreadParticipantRootIds !== undefined;
  if (
    authoritativeReplyTargets !== undefined
      ? authoritativeReplyTargets.has(messageId)
      : !hasAuthoritativeThreadMembership && senderMatchesIdentity(message.reply_to?.sender, identity)
  ) {
    return decision("activate", "reply_target");
  }

  if (isAgentReplyTarget(message.reply_to) && !isThreadReply(message)) {
    return decision("silent", "other_reply_target");
  }

  if (
    isThreadReply(message)
    && (hasAuthoritativeThreadMembership
      ? authoritativeThreadParticipantRootIds.has(threadRootId(message))
      : threadParticipantsIncludeIdentity(message, identity))
  ) {
    return decision("activate", "thread_participant");
  }

  const taskOwnerDecision = decideTaskOwnerActivation(message, identity, context);
  if (taskOwnerDecision) {
    return taskOwnerDecision;
  }

  return decision("unclear", "unaddressed");
}

function decision(
  decisionValue: AgentMessageActivationDecision,
  reason: AgentMessageActivationReason,
): AgentMessageActivation["for_current_agent"] {
  return {
    decision: decisionValue,
    reason,
    addressed: decisionValue === "activate",
  };
}

function isThreadReply(message: MessageLike): boolean {
  const ownId = normalizedString(message.id);
  const rootId = threadRootId(message);
  return Boolean(ownId && rootId && ownId !== rootId);
}

function threadRootId(message: MessageLike): string {
  return normalizedString(message.thread_root_id) || normalizedString(message.thread?.root_message_id);
}

function isAgentReplyTarget(replyTo: MessageLike["reply_to"]): boolean {
  return normalizeSender(replyTo?.source) === "agent";
}

function threadParticipantsIncludeIdentity(
  message: MessageLike,
  identity: ActivationIdentity,
): boolean {
  const senders = [
    message.reply_to?.sender,
    message.thread?.latest_reply?.sender,
    ...(message.thread?.participants ?? []).map((participant) => participant.sender),
  ];

  return senders.some((sender) => senderMatchesIdentity(sender, identity));
}

function decideTaskOwnerActivation(
  message: MessageLike,
  identity: ActivationIdentity,
  context: AgentMessageActivationContext,
): AgentMessageActivation["for_current_agent"] | null {
  if (!isTaskOwnerFollowUp(message.text)) {
    return null;
  }

  const owners = uniqueActiveWorkOwners(context.activeTaskLeases ?? []);
  if (owners.length !== 1) {
    return null;
  }

  const owner = owners[0];
  if (senderMatchesLeaseOwner(message.sender, owner)) {
    return null;
  }

  if (leaseOwnerMatchesIdentity(owner, identity)) {
    return decision("activate", "task_owner");
  }

  if (identityOverlapsLeaseOwner(identity, owner)) {
    return null;
  }

  return decision("silent", "task_owner");
}

function uniqueActiveWorkOwners(leases: readonly ActivationTaskLeaseLike[]): ActivationTaskLeaseLike[] {
  const ownersByKey = new Map<string, ActivationTaskLeaseLike>();

  for (const lease of leases) {
    if (lease.kind !== "work" || lease.status !== "active") continue;
    const key = leaseOwnerKey(lease);
    if (!key) continue;
    ownersByKey.set(key, lease);
  }

  return [...ownersByKey.values()];
}

function leaseOwnerKey(lease: ActivationTaskLeaseLike): string | null {
  const sessionId = normalizedString(lease.agent_session_id);
  if (sessionId) return `session:${sessionId}`;

  const instanceId = normalizedString(lease.agent_instance_id);
  const agentKey = normalizeSender(lease.agent_key);
  if (instanceId) return `instance:${agentKey}:${instanceId}`;
  if (agentKey) return `agent:${agentKey}`;

  const actorLabel = normalizeSender(lease.actor_label);
  return actorLabel ? `label:${actorLabel}` : null;
}

function leaseOwnerMatchesIdentity(
  lease: ActivationTaskLeaseLike,
  identity: ActivationIdentity,
): boolean {
  const leaseSessionId = normalizedString(lease.agent_session_id);
  if (leaseSessionId) {
    return leaseSessionId === normalizedString(identity.agent_session_id);
  }

  const leaseInstanceId = normalizedString(lease.agent_instance_id);
  if (leaseInstanceId) {
    return (
      leaseInstanceId === normalizedString(identity.agent_instance_id) &&
      normalizeSender(lease.agent_key) === normalizeSender(identity.agent_key)
    );
  }

  const leaseAgentKey = normalizeSender(lease.agent_key);
  if (leaseAgentKey) {
    return leaseAgentKey === normalizeSender(identity.agent_key);
  }

  return senderMatchesIdentity(lease.actor_label, identity);
}

function senderMatchesLeaseOwner(sender: unknown, lease: ActivationTaskLeaseLike): boolean {
  const normalizedSender = normalizeSender(sender);
  if (!normalizedSender) return false;

  return leaseOwnerAliases(lease).has(normalizedSender);
}

function identityOverlapsLeaseOwner(
  identity: ActivationIdentity,
  lease: ActivationTaskLeaseLike,
): boolean {
  const identityAliasesForOwner = aliasesForValues([
    identity.actor_label,
    identity.display_name,
    identity.agent_key,
    identity.agent_instance_id,
    identity.agent_session_id,
  ]);

  for (const ownerAlias of leaseOwnerAliases(lease)) {
    if (identityAliasesForOwner.has(ownerAlias)) {
      return true;
    }
  }

  return false;
}

function leaseOwnerAliases(lease: ActivationTaskLeaseLike): Set<string> {
  return aliasesForValues([
    lease.actor_label,
    ...String(lease.actor_label || "").split("|"),
    lease.agent_key,
    lease.agent_instance_id,
    lease.agent_session_id,
  ]);
}

function aliasesForValues(values: readonly unknown[]): Set<string> {
  const aliases = new Set<string>();
  for (const value of values) {
    const senderAlias = normalizeSender(value);
    if (senderAlias) aliases.add(senderAlias);
    const handleAlias = normalizeHandle(value);
    if (handleAlias) aliases.add(handleAlias);
  }
  return aliases;
}

function senderMatchesIdentity(sender: unknown, identity: ActivationIdentity): boolean {
  const normalizedSender = normalizeSender(sender);
  if (!normalizedSender) return false;

  const aliases = activationIdentityAliases(identity);
  if (aliases.has(normalizedSender)) return true;

  return String(sender || "")
    .split("|")
    .some((part) => aliases.has(normalizeSender(part)));
}

export function activationIdentityAliases(identity: ActivationIdentity): Set<string> {
  return routingIdentityAliases(identity);
}

/** Canonical aliases materialized from a historical message sender. */
export function activationSenderAliases(sender: unknown, segmentLimit = 16): Set<string> {
  return routingSenderAliases(sender, segmentLimit);
}

/**
 * Resolve identity-bearing addresses against the complete active room
 * population. A display alias is authority only when it names one durable
 * agent key globally; account/provider filtering happens after this step.
 * Full historical sender labels take precedence over their pipe-delimited
 * compatibility segments.
 */
export function resolveGloballyAddressedAgentKeys(
  message: Pick<MessageLike, "text" | "reply_to">,
  identities: readonly ActivationIdentity[],
): { explicitMentionKeys: Set<string>; replyTargetKeys: Set<string> } {
  return createGlobalAgentAddressResolver(identities)(message);
}

export interface GlobalAgentAddressResolverOptions {
  /**
   * Break a duplicate friendly-name tie only when exactly one of the durable
   * identities is currently reachable. Canonical agent-key aliases remain
   * unique without this hint, and multiple reachable matches still fail
   * closed.
   */
  preferredExplicitMentionAgentKeys?: ReadonlySet<string>;
  /**
   * Stable ownership boundary for each preferred key. Reachability may only
   * break a tie when every colliding durable key belongs to the same scope.
   */
  explicitMentionOwnerScopeByAgentKey?: ReadonlyMap<string, string>;
}

/**
 * Build the room-wide alias authority once, then resolve a page of legacy
 * messages without rebuilding every active worker alias set per message.
 */
export function createGlobalAgentAddressResolver(
  identities: readonly ActivationIdentity[],
  options: GlobalAgentAddressResolverOptions = {},
): (message: Pick<MessageLike, "text" | "reply_to"> & Partial<Pick<MessageLike, "sender">>) => {
  broadcast: boolean;
  hasMention: boolean;
  hasAgentMention: boolean;
  explicitMentionKeys: Set<string>;
  replyTargetKeys: Set<string>;
  senderKeys: Set<string>;
} {
  const keysByAlias = new Map<string, Set<string>>();
  for (const identity of identities) {
    const key = normalizedString(identity.agent_key);
    if (!key) continue;
    for (const alias of activationIdentityAliases(identity)) {
      const keys = keysByAlias.get(alias) ?? new Set<string>();
      keys.add(key);
      keysByAlias.set(alias, keys);
    }
  }

  const resolveExplicitMentionKey = (keys: ReadonlySet<string> | undefined): string | null => {
    if (!keys || keys.size === 0) return null;
    if (keys.size === 1) return keys.values().next().value!;

    const preferredMatches = [...keys].filter((key) =>
      options.preferredExplicitMentionAgentKeys?.has(key));
    if (preferredMatches.length !== 1) return null;

    const ownerScopes = new Set<string>();
    for (const key of keys) {
      const scope = options.explicitMentionOwnerScopeByAgentKey?.get(key);
      if (!scope) return null;
      ownerScopes.add(scope);
    }
    return ownerScopes.size === 1 ? preferredMatches[0]! : null;
  };

  return (message) => {
    const mentions = extractMentionHandles(message.text);
    const broadcast = mentions.some(isBroadcastHandle) || hasBroadcastAddress(message.text);
    const hasMention = mentions.some((mention) => !isBroadcastHandle(mention));
    const hasAgentMention = mentions.some(isLikelyAgentMentionHandle);
    const explicitMentionKeys = new Set<string>();
    for (const mention of mentions) {
      if (isBroadcastHandle(mention)) continue;
      const alias = normalizeMentionIdentityHandle(mention);
      if (!alias) continue;
      const resolvedKey = resolveExplicitMentionKey(keysByAlias.get(alias));
      if (resolvedKey) explicitMentionKeys.add(resolvedKey);
    }

    const replyTargetKeys = new Set<string>();
    const replyAliases = normalizedString(message.reply_to?.source) === "agent"
      ? routingSenderAliasRows(message.reply_to?.sender)
      : [];
    const matchingKeys = (full: boolean): Set<string> => {
      const keys = new Set<string>();
      for (const row of replyAliases) {
        if (row.isFull !== full) continue;
        for (const key of keysByAlias.get(row.alias) ?? []) keys.add(key);
      }
      return keys;
    };
    const fullMatches = matchingKeys(true);
    const replyMatches = fullMatches.size > 0 ? fullMatches : matchingKeys(false);
    if (replyMatches.size === 1) replyTargetKeys.add(replyMatches.values().next().value!);

    const senderKeys = new Set<string>();
    const senderAliases = routingSenderAliasRows(message.sender);
    const senderMatchingKeys = (full: boolean): Set<string> => {
      const keys = new Set<string>();
      for (const row of senderAliases) {
        if (row.isFull !== full) continue;
        for (const key of keysByAlias.get(row.alias) ?? []) keys.add(key);
      }
      return keys;
    };
    const senderFullMatches = senderMatchingKeys(true);
    const senderMatches = senderFullMatches.size > 0
      ? senderFullMatches
      : senderMatchingKeys(false);
    if (senderMatches.size === 1) senderKeys.add(senderMatches.values().next().value!);

    return {
      broadcast,
      hasMention,
      hasAgentMention,
      explicitMentionKeys,
      replyTargetKeys,
      senderKeys,
    };
  };
}

/** Shared legacy task-follow-up classifier used by API and desktop overlays. */
export function isTaskOwnerFollowUpMessageText(text: unknown): boolean {
  return isTaskOwnerFollowUp(text);
}

function extractMentionHandles(text: unknown): string[] {
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
  const raw = normalizedString(handle);
  if (!raw) return false;
  const normalized = raw.toLowerCase();
  const firstSegment = normalized.split("/", 1)[0].replace(/_/g, "-");
  if (normalized.startsWith("agent:")) return true;
  if (normalized.includes("/") && normalized === raw) return false;
  return !NON_AGENT_AT_HANDLES.has(firstSegment);
}

function hasBroadcastAddress(text: unknown): boolean {
  const raw = typeof text === "string" ? text.toLowerCase() : "";
  return /\b(everyone|all agents|you guys|both of you|any agent|whoever owns this)\b/.test(raw);
}

function isTaskOwnerFollowUp(text: unknown): boolean {
  const raw = typeof text === "string" ? text.trim().toLowerCase() : "";
  if (!raw) return false;
  return TASK_OWNER_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(raw));
}

function normalizedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSender(value: unknown): string {
  return normalizeRoutingSender(value);
}

function normalizeHandle(value: unknown): string {
  return normalizeRoutingHandle(value);
}

function normalizeMentionIdentityHandle(value: unknown): string {
  const normalized = normalizeHandle(value);
  return normalized.startsWith("agent:") ? normalized.slice("agent:".length) : normalized;
}

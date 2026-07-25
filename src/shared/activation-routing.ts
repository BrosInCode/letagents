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
  | "system_event"
  | "unaddressed";

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
    const msgNum = parseInt(msgIdStr.replace(/^msg_/, ""), 10);
    const receipt = !isNaN(msgNum) ? receiptsMap.get(msgNum) || receiptsMap.get(msgIdStr) : null;

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

    if (!isNaN(msgNum) && snapshotNumbers.has(msgNum)) {
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
  if (normalizeSender(message.source) === "managed_agent_failure") {
    return decision("silent", "system_event");
  }
  if (senderMatchesIdentity(message.sender, identity)) {
    return decision("silent", "self_message");
  }

  const mentions = extractMentionHandles(message.text);
  if (mentions.some(isBroadcastHandle)) {
    return decision("activate", "broadcast");
  }
  if (mentions.some((mention) => identityAliases(identity).has(normalizeMentionIdentityHandle(mention)))) {
    return decision("activate", "explicit_mention");
  }
  if (hasBroadcastAddress(message.text)) {
    return decision("activate", "broadcast");
  }
  if (mentions.some(isLikelyAgentMentionHandle)) {
    return decision("silent", "explicit_other_mention");
  }

  if (senderMatchesIdentity(message.reply_to?.sender, identity)) {
    return decision("activate", "reply_target");
  }

  if (isAgentReplyTarget(message.reply_to) && !isThreadReply(message)) {
    return decision("silent", "other_reply_target");
  }

  if (isThreadReply(message) && threadParticipantsIncludeIdentity(message, identity)) {
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
  const rootId = normalizedString(message.thread_root_id) || normalizedString(message.thread?.root_message_id);
  return Boolean(ownId && rootId && ownId !== rootId);
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

  const aliases = identityAliases(identity);
  if (aliases.has(normalizedSender)) return true;

  return String(sender || "")
    .split("|")
    .some((part) => aliases.has(normalizeSender(part)));
}

function identityAliases(identity: ActivationIdentity): Set<string> {
  const aliases = new Set<string>();
  const values = [
    identity.actor_label,
    identity.display_name,
    identity.agent_key,
    identity.agent_key.split("/").pop(),
  ];
  for (const alias of aliasesForValues(values)) aliases.add(alias);
  return aliases;
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
  return normalizedString(value).toLowerCase().replace(/\s+/g, " ");
}

function normalizeHandle(value: unknown): string {
  return normalizedString(value).toLowerCase().replace(/[^a-z0-9_.:/-]+/g, "");
}

function normalizeMentionIdentityHandle(value: unknown): string {
  const normalized = normalizeHandle(value);
  return normalized.startsWith("agent:") ? normalized.slice("agent:".length) : normalized;
}

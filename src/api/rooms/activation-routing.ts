import type { ResolvedRequestAgentIdentity } from "../request/agent-identity.js";

export type AgentMessageActivationDecision = "activate" | "silent" | "unclear";

export type AgentMessageActivationReason =
  | "self_message"
  | "explicit_mention"
  | "explicit_other_mention"
  | "broadcast"
  | "reply_target"
  | "thread_participant"
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
  reply_to?: { sender?: unknown } | null;
};

type ActivationIdentity = Pick<
  ResolvedRequestAgentIdentity,
  "actor_label" | "agent_key" | "display_name" | "session_kind"
>;

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

export function attachAgentMessageActivation<T extends MessageLike>(
  message: T,
  identity: ActivationIdentity,
): T & { activation: AgentMessageActivation } {
  return {
    ...message,
    activation: {
      for_current_agent: decideAgentMessageActivation(message, identity),
    },
  };
}

export function attachAgentMessageActivations<T extends MessageLike>(
  messages: readonly T[],
  identity: ActivationIdentity | null,
): T[] | Array<T & { activation: AgentMessageActivation }> {
  if (!identity || identity.session_kind !== "worker") {
    return [...messages];
  }

  return messages.map((message) => attachAgentMessageActivation(message, identity));
}

export function decideAgentMessageActivation(
  message: MessageLike,
  identity: ActivationIdentity,
): AgentMessageActivation["for_current_agent"] {
  if (senderMatchesIdentity(message.sender, identity)) {
    return decision("silent", "self_message");
  }

  const mentions = extractMentionHandles(message.text);
  if (mentions.some(isBroadcastHandle)) {
    return decision("activate", "broadcast");
  }
  if (mentions.some((mention) => identityAliases(identity).has(normalizeHandle(mention)))) {
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

  if (isThreadReply(message) && threadParticipantsIncludeIdentity(message, identity)) {
    return decision("activate", "thread_participant");
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
  for (const value of [
    identity.actor_label,
    identity.display_name,
    identity.agent_key,
    identity.agent_key.split("/").pop(),
  ]) {
    const senderAlias = normalizeSender(value);
    if (senderAlias) aliases.add(senderAlias);
    const handleAlias = normalizeHandle(value);
    if (handleAlias) aliases.add(handleAlias);
  }
  return aliases;
}

function extractMentionHandles(text: unknown): string[] {
  const raw = typeof text === "string" ? text : "";
  const mentions: string[] = [];
  for (const match of raw.matchAll(/(^|[\s([{:;,])@([A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)?)/g)) {
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
  if (normalized.includes("/") && normalized === raw) return false;
  const firstSegment = normalized.split("/", 1)[0].replace(/_/g, "-");
  return !NON_AGENT_AT_HANDLES.has(firstSegment);
}

function hasBroadcastAddress(text: unknown): boolean {
  const raw = typeof text === "string" ? text.toLowerCase() : "";
  return /\b(everyone|all agents|you guys|both of you|any agent|whoever owns this)\b/.test(raw);
}

function normalizedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSender(value: unknown): string {
  return normalizedString(value).toLowerCase().replace(/\s+/g, " ");
}

function normalizeHandle(value: unknown): string {
  return normalizedString(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, "");
}

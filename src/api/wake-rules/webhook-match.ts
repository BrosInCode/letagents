/**
 * Which room.message webhook rules a new message matches. Pure: the caller
 * supplies what send-time routing decided, so a webhook follows the same
 * activation rules as an agent that polls.
 */
import {
  activationIdentityAliases,
  activationSenderAliases,
  createGlobalAgentAddressResolver,
  isUntrustedExternalActivationSource,
  type ActivationIdentity,
} from "../../shared/activation-routing.js";
import type { WakeRuleArguments } from "../../../shared/wake-rules.mjs";

export interface WakeWebhookRuleCandidate {
  id: string;
  agent_key: string;
  agent_name: string;
  arguments: WakeRuleArguments;
}

export interface WakeWebhookMessageFacts {
  sender: string;
  source: string | null;
  publisher_agent_key: string | null;
  thread_root_number: number | null;
  text: string;
  /** Blank automatic prompts never wake anyone. */
  promptOnly: boolean;
  /** Visible only to some participants (rental projections): only an exact recipient matches. */
  restricted: boolean;
  /** A system notice for exactly one agent (a wake notice). */
  addressedAgentKey: string | null;
  /** Agents that got a receipt for this message from send-time routing. */
  recipientAgentKeys: ReadonlySet<string>;
  /**
   * Live worker identities routing considered. Complete whenever the message
   * mentions anyone, which is the only case the fallback below reads it.
   */
  activeIdentities: readonly ActivationIdentity[];
  /** The message in the shape routing reads (`id`, `sender`, `text`, `source`, `reply_to`). */
  routingMessage: Parameters<ReturnType<typeof createGlobalAgentAddressResolver>>[0];
}

function ruleIdentity(rule: WakeWebhookRuleCandidate): ActivationIdentity {
  return {
    actor_label: rule.agent_name,
    agent_key: rule.agent_key,
    agent_instance_id: null,
    agent_session_id: null,
    display_name: rule.agent_name,
    session_kind: "worker",
  };
}

/** The agent's own message: by its authenticated identity, or by name for an older unsigned agent post. */
export function isOwnWakeWebhookMessage(rule: WakeWebhookRuleCandidate, facts: Pick<WakeWebhookMessageFacts, "sender" | "source" | "publisher_agent_key">): boolean {
  if (facts.publisher_agent_key) return facts.publisher_agent_key === rule.agent_key;
  if (facts.source !== "agent") return false;
  const aliases = activationIdentityAliases(ruleIdentity(rule));
  return [...activationSenderAliases(facts.sender)].some((alias) => aliases.has(alias));
}

/**
 * The rules this message wakes.
 *
 * `mentions_me`: the message is for the rule's agent. That is what routing
 * decided (a receipt: a mention, a reply to it, its thread, a task follow-up,
 * a small-room fallback), or a notice addressed to it, or, when the agent has
 * no live session for routing to consider, a mention that names it and no
 * other agent in the room.
 *
 * `any`: every top-level message, except notices addressed to another agent
 * and, unless `include_agents`, other agents' messages: two bots that each
 * take every message would otherwise wake each other without end.
 *
 * Never the agent's own messages, and never a blank automatic prompt.
 */
export function matchWakeWebhookRules<T extends WakeWebhookRuleCandidate>(
  rules: readonly T[],
  facts: WakeWebhookMessageFacts,
): T[] {
  if (facts.promptOnly || rules.length === 0) return [];
  const activeKeys = new Set(facts.activeIdentities.map((identity) => identity.agent_key));
  let mentioned: ReadonlySet<string> | null = null;
  const mentionedWithoutSession = (): ReadonlySet<string> => {
    if (mentioned) return mentioned;
    // Repository text is never an instruction channel, so it never names an agent here either.
    if (isUntrustedExternalActivationSource(facts.source) || facts.restricted || !facts.text.includes("@")) {
      mentioned = new Set();
      return mentioned;
    }
    const absent = rules.filter((rule) => !activeKeys.has(rule.agent_key)).map(ruleIdentity);
    // Resolved with the live agents too: a name two agents share wakes neither.
    mentioned = createGlobalAgentAddressResolver([...facts.activeIdentities, ...absent])(facts.routingMessage).explicitMentionKeys;
    return mentioned;
  };
  return rules.filter((rule) => {
    if (isOwnWakeWebhookMessage(rule, facts)) return false;
    if (facts.addressedAgentKey) return facts.addressedAgentKey === rule.agent_key;
    const forThisAgent = facts.recipientAgentKeys.has(rule.agent_key);
    if (rule.arguments.any) {
      const fromAgent = facts.source === "agent" || Boolean(facts.publisher_agent_key);
      return forThisAgent || (!facts.restricted && facts.thread_root_number === null && (!fromAgent || Boolean(rule.arguments.include_agents)));
    }
    if (forThisAgent) return true;
    return !activeKeys.has(rule.agent_key) && mentionedWithoutSession().has(rule.agent_key);
  });
}

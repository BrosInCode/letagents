export type AgentMessageActivationDecision = "activate" | "silent" | "unclear";
export type AgentMessageActivationReason = "self_message" | "explicit_mention" | "explicit_other_mention" | "broadcast" | "reply_target" | "other_reply_target" | "thread_participant" | "task_owner" | "small_room" | "recent_conversation" | "system_event" | "unaddressed";
/** Send-time human fallback only; never use this to re-route historical reads. */
export declare function humanConversationFallback(input: {
    source: string | null;
    publisherAccountId: string | null;
    publisherAgentKey: string | null;
    explicitlyAddressed: boolean;
    registeredAgentKeys: readonly string[];
    recentAgentKey?: string | null;
}): {
    reason: "small_room" | "recent_conversation";
    agentKeys: string[];
} | null;
/**
 * Repository events can contain text written by any external contributor.
 * They remain visible room activity, but their text is never an instruction
 * channel for a managed local worker.
 */
export declare function isUntrustedExternalActivationSource(source: unknown): boolean;
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
        participants?: Array<{
            sender?: unknown;
        }> | null;
        latest_reply?: {
            sender?: unknown;
        } | null;
    } | null;
    reply_to?: {
        sender?: unknown;
        source?: unknown;
    } | null;
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
    authoritativeLegacyDecisions?: ReadonlyMap<string, AgentMessageActivation["for_current_agent"]>;
};
export declare function attachAgentMessageActivation<T extends MessageLike>(message: T, identity: ActivationIdentity, context?: AgentMessageActivationContext): T & {
    activation: AgentMessageActivation;
};
/**
 * Send-time receipts are the activation authority. For a snapshot-bearing
 * message, a receipt activates and the absence of one is the durable
 * send-time "silent" — never re-promoted by re-running the router against
 * later task/thread/session state, which would create a second authority.
 * Only messages that predate routing snapshots keep the lazy per-reader
 * decision, so legacy backlog mentions still activate rotated sessions.
 */
export declare function attachAgentMessageActivationsFromReceipts<T extends MessageLike>(messages: readonly T[], identity: ActivationIdentity | null, receiptsMap: ReadonlyMap<number | string, {
    activation_reason: string;
}>, snapshotNumbers: ReadonlySet<number>, context?: AgentMessageActivationContext): T[] | Array<T & {
    activation: AgentMessageActivation;
}>;
export declare function attachAgentMessageActivations<T extends MessageLike>(messages: readonly T[], identity: ActivationIdentity | null, context?: AgentMessageActivationContext): T[] | Array<T & {
    activation: AgentMessageActivation;
}>;
export declare function decideAgentMessageActivation(message: MessageLike, identity: ActivationIdentity, context?: AgentMessageActivationContext): AgentMessageActivation["for_current_agent"];
export declare function activationIdentityAliases(identity: ActivationIdentity): Set<string>;
/** Canonical aliases materialized from a historical message sender. */
export declare function activationSenderAliases(sender: unknown, segmentLimit?: number): Set<string>;
/**
 * Resolve identity-bearing addresses against the complete active room
 * population. A display alias is authority only when it names one durable
 * agent key globally; account/provider filtering happens after this step.
 * Full historical sender labels take precedence over their pipe-delimited
 * compatibility segments.
 */
export declare function resolveGloballyAddressedAgentKeys(message: Pick<MessageLike, "text" | "reply_to">, identities: readonly ActivationIdentity[]): {
    explicitMentionKeys: Set<string>;
    replyTargetKeys: Set<string>;
};
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
export declare function createGlobalAgentAddressResolver(identities: readonly ActivationIdentity[], options?: GlobalAgentAddressResolverOptions): (message: Pick<MessageLike, "text" | "reply_to"> & Partial<Pick<MessageLike, "sender">>) => {
    broadcast: boolean;
    hasMention: boolean;
    hasAgentMention: boolean;
    explicitMentionKeys: Set<string>;
    replyTargetKeys: Set<string>;
    senderKeys: Set<string>;
};
/** Shared legacy task-follow-up classifier used by API and desktop overlays. */
export declare function isTaskOwnerFollowUpMessageText(text: unknown): boolean;
export {};

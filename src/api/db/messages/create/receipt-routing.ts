/**
 * Routes a message to the room's active worker sessions: addresses, fallbacks,
 * Jev plans, receipts and reply-turn holds.
 */
import { JEV_MAX_CANDIDATE_AGENTS } from "../../../messages/jev-conversation-routing.js";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { isPromptOnlyAgentMessage } from "../../../../shared/room-agent-prompts.js";
import { createGlobalAgentAddressResolver, humanConversationFallback, decideAgentMessageActivation, type ActivationIdentity } from "../../../../shared/activation-routing.js";
import { RequestValidationError } from "../../../validation-error.js";
import { chooseAnsweringSession, chooseSessionForReply } from "../../../rooms/answering-session.js";
import { getReplyTurnReadySessions } from "../session-connections.js";
import { rooms, room_settings, jev_routing_jobs, messages } from "../../schema.js";
import type { MessageMentionNotice, MessageRecipientAgentTarget, MessageRow } from "../../types.js";
import { createAccountRoutingTargetBudget, getRecentHumanConversationRecipient, getHumanThreadRootRecipientOwners, MAX_ACCOUNT_ROUTING_ENVELOPE_BYTES, MAX_ACCOUNT_ROUTING_TARGETS } from "../account-agent-routing.js";
import { planJevRoutingMode, type DeferredJevRoutingPlan } from "../jev-routing-hint.js";
import { resolveMessageThreadRoutingProjection } from "../thread-routing-membership.js";
import { planReplyTurns, releaseAgentReplyTurnHoldsTx, sequentialReplyReason, type ReleasedReplyTurn } from "../reply-turns.js";
import type { MessageCreateTransaction } from "./types.js";
import { insertMessageReceiptRows } from "./receipt-rows.js";
import type { MessageRoutingContext } from "./routing-context.js";

/**
 * Chooses one receipt per durable agent among the active worker sessions,
 * plans reply turns, writes the receipts and releases held turns that this
 * message must get past.
 */
export async function routeMessageToActiveSessions(
  tx: MessageCreateTransaction,
  roomId: string,
  createdMessage: MessageRow,
  createdMessageIsPromptOnly: boolean,
  routing: MessageRoutingContext,
  releasedReplyTurns: ReleasedReplyTurn[],
): Promise<{
  receiptCount: number;
  recipientAgentKeys: readonly string[];
  recipientAgentTargets: readonly MessageRecipientAgentTarget[];
  mentionNotices: readonly MessageMentionNotice[];
}> {
  let receiptCount = 0;
  let recipientAgentKeys: readonly string[] = [];
  let recipientAgentTargets: readonly MessageRecipientAgentTarget[] = [];
  let mentionNotices: readonly MessageMentionNotice[] = [];
  const {
    taskOwnerFollowUp,
    leases,
    replyToMessage,
    routingThreadRootNumber,
    threadRoutingProjection,
    messageForRouting,
    routingShape,
    replyToIsHuman,
    humanConversationEligible,
    activeSessions,
    reachableAgentKeys,
    connectedSessionIds,
  } = routing;
  // Resolve routing against every overlapping session identity first.
  // Only a durable key with one owner may choose a deterministic session
  // representative for its single receipt after routing is complete.
  const sessionsByAgentKey = new Map<string, {
    sessions: (typeof activeSessions)[number][];
    identities: ActivationIdentity[];
    ownerAccountIds: Set<string>;
  }>();
  for (const session of activeSessions) {
    const group = sessionsByAgentKey.get(session.agent_key) ?? {
      sessions: [],
      identities: [],
      ownerAccountIds: new Set<string>(),
    };
    group.sessions.push(session);
    group.identities.push({
      actor_label: session.actor_label,
      agent_key: session.agent_key,
      agent_instance_id: session.agent_instance_id,
      agent_session_id: session.session_id,
      display_name: session.display_name,
      session_kind: session.session_kind,
    });
    group.ownerAccountIds.add(session.owner_account_id);
    sessionsByAgentKey.set(session.agent_key, group);
  }
  const allRoutingIdentities = [...sessionsByAgentKey.values()].flatMap(({ identities }) => identities);
  const threadMembership = new Set(
    resolveMessageThreadRoutingProjection(
      threadRoutingProjection,
      activeSessions.map((session) => ({
        actor_label: session.actor_label,
        agent_key: session.agent_key,
        agent_instance_id: session.agent_instance_id,
        agent_session_id: session.session_id,
        display_name: session.display_name,
        session_kind: session.session_kind,
        owner_account_id: session.owner_account_id,
      })),
    ).get(routingThreadRootNumber)?.map((member) => member.agent_key) ?? [],
  );
  const ownedSessionGroups = [...sessionsByAgentKey]
    .filter(([, group]) => group.ownerAccountIds.size === 1);
  const ownerScopeByAgentKey = new Map(ownedSessionGroups.map(([agentKey, group]) => [
    agentKey,
    group.ownerAccountIds.values().next().value!,
  ]));
  const globalAddresses = createGlobalAgentAddressResolver(allRoutingIdentities, {
    preferredExplicitMentionAgentKeys: reachableAgentKeys,
    explicitMentionOwnerScopeByAgentKey: ownerScopeByAgentKey,
  })(messageForRouting);
  // An ambiguous mention wakes nobody. Say so on the sender's own
  // acknowledgement, with a mention that reaches each candidate alone.
  mentionNotices = globalAddresses.ambiguousMentions.map(({ handle, agentKeys }) => ({
    reason: "ambiguous" as const,
    handle,
    detail: `@${handle} matches ${agentKeys.length} agents in this room, so the mention reached none of them. `
      + "Resend with the exact mention of the agent you mean.",
    candidates: agentKeys.flatMap((agentKey) => {
      const session = chooseAnsweringSession(sessionsByAgentKey.get(agentKey)?.sessions ?? [], connectedSessionIds);
      return session ? [{
        agent_key: agentKey,
        display_name: session.display_name,
        actor_label: session.actor_label,
        mention: `@agent:${agentKey}`,
      }] : [];
    }),
  }));
  let exactReplySession: (typeof activeSessions)[number] | undefined;
  if (replyToMessage?.publisher_agent_key && replyToMessage.publisher_account_id) {
    globalAddresses.replyTargetKeys.clear();
    const replyGroup = sessionsByAgentKey.get(replyToMessage.publisher_agent_key);
    if (
      replyGroup?.ownerAccountIds.size === 1
      && replyGroup.ownerAccountIds.has(replyToMessage.publisher_account_id)
    ) {
      globalAddresses.replyTargetKeys.add(replyToMessage.publisher_agent_key);
      exactReplySession = replyToMessage.publisher_agent_session_id
        ? replyGroup.sessions.find((session) =>
            session.session_id === replyToMessage.publisher_agent_session_id)
        : undefined;
    }
  }

  // Top-level answers do not make an agent a thread participant. Let a
  // human's first unaddressed thread follow-up reach the root's captured
  // audience without making every subsequent peer reply a broadcast.
  if (createdMessage.source === "browser" && createdMessage.publisher_account_id
    && !createdMessage.publisher_agent_key && !createdMessageIsPromptOnly
    && createdMessage.thread_root_number !== null && threadMembership.size === 0
    && !globalAddresses.broadcast && !globalAddresses.hasMention
    && !replyToMessage?.publisher_agent_key && replyToMessage?.source !== "agent"
    && replyToMessage?.visibility == null && replyToMessage?.rental_session_id == null
    && !(taskOwnerFollowUp && leases.length > 0)) {
    const rootRecipients = await getHumanThreadRootRecipientOwners(
      tx, roomId, routingThreadRootNumber, createdMessage.number, ownedSessionGroups.map(([key]) => key),
    );
    for (const [key, capturedOwner] of rootRecipients) {
      if (ownerScopeByAgentKey.get(key) === capturedOwner) threadMembership.add(key);
    }
  }

  const recentRecipient = humanConversationEligible && sessionsByAgentKey.size > 2
    ? await getRecentHumanConversationRecipient(tx, roomId, {
        number: createdMessage.number, timestamp: createdMessage.timestamp,
        publisher_account_id: createdMessage.publisher_account_id!,
      }) : null;
  const heuristicFallback = humanConversationFallback({
    source: createdMessage.source, publisherAccountId: createdMessage.publisher_account_id,
    publisherAgentKey: createdMessage.publisher_agent_key,
    explicitlyAddressed: !humanConversationEligible,
    // Registration is durable; transport freshness must not change room size.
    // Paused workers remain registered until their server session ends.
    registeredAgentKeys: [...sessionsByAgentKey.keys()],
    recentAgentKey: recentRecipient && ownerScopeByAgentKey.get(recentRecipient.agentKey) === recentRecipient.ownerAccountId
      ? recentRecipient.agentKey : null,
  });
  // Jev only ever replaces the untagged fallback, and only in rooms of
  // three or more agents; mentions, replies to agents, threads, and task
  // ownership stay deterministic. Inference runs after commit: in active
  // mode the fallback is withheld here and the deferred pass applies
  // Jev's election (or this heuristic when Jev is unavailable); shadow
  // mode applies the heuristic now and only compares afterwards.
  const [routingRoom] = await tx.select({ enabled: rooms.jev_routing_enabled }).from(rooms).where(eq(rooms.id, roomId));
  const jevMode = routingRoom?.enabled ? planJevRoutingMode() : null;
  const jevEligible = jevMode !== null
    && sessionsByAgentKey.size > 2
    && sessionsByAgentKey.size <= JEV_MAX_CANDIDATE_AGENTS
    && !taskOwnerFollowUp
    && !createdMessageIsPromptOnly
    && !routingShape.broadcast && !routingShape.hasMention
    && createdMessage.thread_root_number === null
    && (createdMessage.reply_to_number === null || replyToIsHuman)
    && humanConversationEligible;
  const jevDecides = jevMode === "active" && jevEligible;
  const humanFallback = jevDecides ? null : heuristicFallback;
  if (jevMode && jevEligible) {
    const plan: DeferredJevRoutingPlan = {
      mode: jevMode,
      roomId,
      message: {
        number: createdMessage.number,
        publisher_agent_key: createdMessage.publisher_agent_key ?? null,
      },
      heuristic: heuristicFallback,
    };
    await tx.insert(jev_routing_jobs).values({ room_id: roomId, message_number: createdMessage.number, plan });
  }

  // Receipts are keyed by durable agent identity: several live sessions
  // (a restart's leftover, mid-rotation overlap, chats sharing an
  // identity) may share one agent_key, but the agent was asked once. The
  // session most likely to be there represents it; the unique
  // (message, agent_key) index makes this a database invariant.
  const receiptsByAgentKey = new Map<string, {
    id: string; message_room_id: string; message_number: number; room_id: string;
    agent_session_id: string; agent_key: string; actor_label: string;
    activation_reason: string; receipt_state: string; created_at: string; updated_at: string;
  }>();
  const taskOwnerThreadRecipients = new Set<string>();

  for (const [agentKey, group] of ownedSessionGroups) {
    if (
      createdMessage.source === "agent"
      && createdMessage.publisher_agent_key === agentKey
    ) continue;
    const representative = chooseAnsweringSession(group.sessions, connectedSessionIds)!;
    // Exact authenticated publisher identity owns self suppression. Do
    // not let a mutable/same-label sender alias suppress an unrelated
    // durable worker when that exact identity is available.
    if (
      createdMessage.source === "agent"
      &&
      !createdMessage.publisher_agent_key
      && globalAddresses.senderKeys.has(agentKey)
    ) continue;
    let selectedActivation: {
      session: (typeof activeSessions)[number];
      activation: { decision: "activate"; reason: string; addressed: true };
    } | undefined;
    if (globalAddresses.broadcast) {
      selectedActivation = {
        session: representative,
        activation: { decision: "activate", reason: "broadcast", addressed: true },
      };
    } else if (globalAddresses.explicitMentionKeys.has(agentKey)) {
      selectedActivation = {
        session: representative,
        activation: { decision: "activate", reason: "explicit_mention", addressed: true },
      };
    } else if (globalAddresses.hasMention) {
      continue;
    } else if (globalAddresses.replyTargetKeys.has(agentKey)) {
      selectedActivation = {
        session: exactReplySession?.agent_key === agentKey
          ? exactReplySession
          : representative,
        activation: { decision: "activate", reason: "reply_target", addressed: true },
      };
    } else if (threadMembership.has(agentKey)) {
      selectedActivation = {
        session: representative,
        activation: { decision: "activate", reason: "thread_participant", addressed: true },
      };
    } else if (humanFallback?.agentKeys.includes(agentKey)) {
      selectedActivation = {
        session: representative,
        activation: { decision: "activate", reason: humanFallback.reason, addressed: true },
      };
    } else if (!humanFallback && taskOwnerFollowUp) {
      const owners = group.identities
        .map((identity, index) => ({
          session: group.sessions[index]!,
          activation: decideAgentMessageActivation(messageForRouting, identity, {
            activeTaskLeases: leases,
            threadParticipantRootIds: new Set<string>(),
          }),
        }))
        .filter(({ activation }) =>
          activation.decision === "activate" && activation.reason === "task_owner");
      // A lease names a session when it can. That session alone may act
      // on the task, so it keeps the follow-up whatever its siblings are
      // doing. A lease that names only the agent is held by whichever of
      // its sessions answers.
      const leaseHolder = owners.find(({ session }) =>
        leases.some((lease) => lease.agent_session_id === session.session_id));
      const owner = leaseHolder ?? (owners.length > 0
        ? { session: representative, activation: owners[0]!.activation }
        : undefined);
      selectedActivation = owner as typeof selectedActivation;
    }

    if (selectedActivation) {
      // Thread membership wins the receipt reason above, but a genuine
      // task follow-up must still reach its existing lease owner promptly.
      // Reuse the task routing check: expired or ambiguous owners do not
      // gain priority merely because the text says "continue".
      if (createdMessage.source === "agent"
        && selectedActivation.activation.reason === "thread_participant"
        && taskOwnerFollowUp
        && group.identities.some(identity => {
          const ownerActivation = decideAgentMessageActivation(messageForRouting, identity, {
            activeTaskLeases: leases, threadParticipantRootIds: new Set<string>(),
          });
          return ownerActivation.reason === "task_owner" && ownerActivation.decision === "activate";
        })) {
        taskOwnerThreadRecipients.add(agentKey);
      }
      const receiptSession = selectedActivation.activation.reason === "task_owner"
        ? selectedActivation.session
        : selectedActivation.activation.reason === "reply_target"
          ? chooseSessionForReply({
              said: selectedActivation.session,
              answering: representative,
              connectedSessionIds,
            })
          : representative;
      const receiptId = `rcpt_${randomUUID().replace(/-/g, "")}`;
      receiptsByAgentKey.set(agentKey, {
        id: receiptId,
        message_room_id: roomId,
        message_number: createdMessage.number,
        room_id: roomId,
        agent_session_id: receiptSession.session_id,
        agent_key: agentKey,
        actor_label: receiptSession.actor_label,
        activation_reason: selectedActivation.activation.reason,
        receipt_state: "queued",
        created_at: createdMessage.timestamp,
        updated_at: createdMessage.timestamp,
      });
    }
  }

  const routedReceipts = [...receiptsByAgentKey.values()];
  // An unaddressed human question to a thread is still a shared conversation.
  // Keep mentions, quoted agents, task follow-ups and all peer messages in
  // their existing lanes; only this verified human shape can sequence
  // thread_participant receipts. No recipient selection changes here.
  const sharedHumanThreadCandidate = routedReceipts.length >= 2
    && createdMessage.source === "browser" && !createdMessageIsPromptOnly
    && Boolean(createdMessage.publisher_account_id) && !createdMessage.publisher_agent_key
    && createdMessage.thread_root_number !== null && !taskOwnerFollowUp
    && !globalAddresses.broadcast && !globalAddresses.hasMention
    && (replyToMessage === null || (replyToMessage.source === "browser"
      && Boolean(replyToMessage.publisher_account_id) && !replyToMessage.publisher_agent_key
      && replyToMessage.visibility === null && replyToMessage.rental_session_id === null));
  // The transaction hook may restrict the persisted message. MessageRow
  // deliberately omits these fields, so inspect the row after that hook
  // rather than treating absent projection fields as public visibility.
  const [visibleHumanRequest] = createdMessage.source === "browser"
    ? await tx.select({ text: messages.text, promptKind: messages.agent_prompt_kind, account: messages.publisher_account_id }).from(messages).where(and(
      eq(messages.room_id, roomId), eq(messages.number, createdMessage.number),
      eq(messages.source, "browser"),
      sql`${messages.publisher_account_id} IS NOT NULL`,
      sql`${messages.publisher_agent_key} IS NULL`, sql`${messages.publisher_agent_session_id} IS NULL`,
      sql`${messages.visibility} IS NULL`, sql`${messages.rental_session_id} IS NULL`,
    )).limit(1) : [];
  const freshHumanRequest = Boolean(visibleHumanRequest?.account?.trim()
    && !isPromptOnlyAgentMessage(visibleHumanRequest.text, visibleHumanRequest.promptKind));
  const sharedHumanThread = sharedHumanThreadCandidate && freshHumanRequest;
  // Several agents woken by one broadcast or small-room message answer
  // one after another only in a room whose admin turned sequential replies
  // on (NULL is parallel). The setting is read only when the receipts
  // could be sequenced at all.
  const sequenceCandidate = routedReceipts.length >= 2
    && routedReceipts.every((receipt) => sequentialReplyReason(receipt.activation_reason, sharedHumanThread));
  const [replyOrder] = sequenceCandidate
    ? await tx.select({ order: room_settings.agent_reply_order })
      .from(room_settings).where(eq(room_settings.room_id, roomId)).for("share")
    : [];
  const receiptRowsToInsert = planReplyTurns(routedReceipts, {
    messageNumber: createdMessage.number,
    timestamp: createdMessage.timestamp,
    sequential: sequenceCandidate && replyOrder?.order === "sequential",
    sharedHumanThread,
    readySessionIds: replyOrder?.order === "sequential"
      ? await getReplyTurnReadySessions(tx, roomId, routedReceipts.map(receipt => receipt.agent_session_id))
      : undefined,
  });
  if (receiptRowsToInsert.length > MAX_ACCOUNT_ROUTING_TARGETS) {
    throw new RequestValidationError("Message fanout exceeds the bounded desktop routing contract.");
  }
  const consumeRoutingTarget = createAccountRoutingTargetBudget();
  for (const receipt of receiptRowsToInsert) {
    consumeRoutingTarget({
      agent_key: receipt.agent_key,
      agent_session_id: receipt.agent_session_id,
    });
  }
  const receiptEnvelopeBytes = Buffer.byteLength(JSON.stringify({
    version: 1,
    authority: "receipts",
    recipient_agent_keys: receiptRowsToInsert.map((receipt) => receipt.agent_key),
    recipient_agent_sessions: receiptRowsToInsert.map((receipt) => ({
      agent_key: receipt.agent_key,
      agent_session_id: receipt.agent_session_id,
    })),
    control_authorized: false,
  }), "utf8");
  if (receiptEnvelopeBytes > MAX_ACCOUNT_ROUTING_ENVELOPE_BYTES) {
    throw new RequestValidationError("Message fanout exceeds the bounded desktop routing envelope.");
  }
  receiptCount = receiptRowsToInsert.length;
  recipientAgentKeys = receiptRowsToInsert.map((receipt) => receipt.agent_key);
  recipientAgentTargets = receiptRowsToInsert.map((receipt) => ({
    agent_key: receipt.agent_key,
    agent_session_id: receipt.agent_session_id,
    owner_account_id: sessionsByAgentKey.get(receipt.agent_key)!.sessions
      .find((session) => session.session_id === receipt.agent_session_id)!.owner_account_id,
  }));
  await insertMessageReceiptRows(tx, receiptRowsToInsert);
  // A newer human correction must get past older holds, while retaining
  // its own reply order. The bound is essential: releasing all holds after
  // insertion would also release the sequence just created above.
  if (freshHumanRequest) releasedReplyTurns.push(...await releaseAgentReplyTurnHoldsTx(
    tx, roomId, receiptRowsToInsert.filter(receipt => receipt.turn_position !== null)
      .map(receipt => receipt.agent_key), createdMessage.number,
  ));
  // A direct activation (mention, reply target, human thread, task owner)
  // must not stay behind an earlier held turn: the frontier would hide it
  // too. Automatic participation in a peer's thread reply is different:
  // keep that receipt, but do not let it release unrelated queued turns.
  // Public human sequences released only older holds above. Their new
  // sequence stays intact; peer/system sequences gain no such bypass.
  releasedReplyTurns.push(...await releaseAgentReplyTurnHoldsTx(
    tx,
    roomId,
    receiptRowsToInsert.filter((receipt) => receipt.turn_position === null
      && (!(createdMessage.source === "agent" && receipt.activation_reason === "thread_participant")
        || taskOwnerThreadRecipients.has(receipt.agent_key)))
      .map((receipt) => receipt.agent_key),
  ));
  return { receiptCount, recipientAgentKeys, recipientAgentTargets, mentionNotices };
}

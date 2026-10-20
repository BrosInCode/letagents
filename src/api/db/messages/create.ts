import { JEV_MAX_CANDIDATE_AGENTS } from "../../messages/jev-conversation-routing.js";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { isPromptOnlyAgentMessage } from "../../../shared/room-agent-prompts.js";
import { MESSAGE_SENDER_MAX_CODE_POINTS, MESSAGE_SENDER_MAX_UTF8_BYTES, isMessageSenderWithinBounds, parseSupervisedReplySourceNumber } from "../../../../shared/message-contracts.mjs";
import { createGlobalAgentAddressResolver, humanConversationFallback, decideAgentMessageActivation, isUntrustedExternalActivationSource, isTaskOwnerFollowUpMessageText, type ActivationIdentity } from "../../../shared/activation-routing.js";
import { RequestValidationError } from "../../validation-error.js";
import { chooseAnsweringSession, chooseSessionForReply } from "../../rooms/answering-session.js";
import { getReplyTurnReadySessions, getSessionConnections } from "./session-connections.js";
import { db } from "../client.js";
import { rooms, room_settings, jev_routing_jobs, messages, room_agent_sessions, message_agent_receipts, message_agent_receipt_events } from "../schema.js";
import type { Message, MessageMentionNotice, MessageRecipientAgentTarget, MessageRow } from "../types.js";
import { createAccountRoutingTargetBudget, getBoundedActiveWorkLeaseOwners, getRecentHumanConversationRecipient, getHumanThreadRootRecipientOwners, MAX_ACCOUNT_ROUTING_ENVELOPE_BYTES, MAX_ACCOUNT_ROUTING_TARGETS } from "./account-agent-routing.js";
import { planJevRoutingMode, type DeferredJevRoutingPlan } from "./jev-routing-hint.js";
import { getMessageThreadRoutingProjection, resolveMessageThreadRoutingProjection, type ThreadRoutingProjection } from "./thread-routing-membership.js";
import { enqueueDesktopPushNotifications } from "../../notifications/enqueue.js";
import { finishReplyTurnsTx, planReplyTurns, queueReplyTurnWakes, releaseAgentReplyTurnHoldsTx, sequentialReplyReason, type ReleasedReplyTurn } from "./reply-turns.js";
import type { MessageCreateTransaction, AddMessageOptions, AddMessageResult } from "./create/types.js";
import { insertMessageReceiptRows } from "./create/receipt-rows.js";
import { hydrateCreatedMessage } from "./create/hydrate.js";
import { normalizeClientMessageId, resolveMessageTargets } from "./create/validation.js";
import { insertMessageRow } from "./create/insert.js";
import { attachMessageUploads } from "./create/attachments.js";
export type { MessageCreateTransaction, AddMessageOptions, AddMessageResult } from "./create/types.js";
export { chunkMessageReceiptRows } from "./create/receipt-rows.js";

const MAX_ACTIVE_ROUTING_SESSIONS = 50_000;

export async function addMessageWithCreateStatus(
  roomId: string,
  sender: string,
  text: string,
  options?: AddMessageOptions,
): Promise<AddMessageResult> {
  if (!isMessageSenderWithinBounds(sender)) {
    throw new RequestValidationError(
      `sender must not exceed ${MESSAGE_SENDER_MAX_CODE_POINTS} characters or ${MESSAGE_SENDER_MAX_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  const promptKind = options?.agent_prompt_kind ?? null;
  const attachmentRefs = options?.attachments ?? [];
  const clientMessageId = normalizeClientMessageId(options?.client_message_id);
  const repliedReceiptTargets = new Set<number>();
  const releasedReplyTurns: ReleasedReplyTurn[] = [];
  // Conversation routing (Jev) never runs inside the send: the plan is
  // captured in the transaction and executed after commit, so the human's
  // send returns as fast as the deterministic ladder alone.
  const result = await db.transaction(async (tx): Promise<AddMessageResult> => {
    // Transitional projection repair can inspect a legacy thread on the first
    // post-watermark reply. Bound that work—and every other statement in this
    // atomic send—so a pathological archive cannot wedge an API worker.
    await tx.execute(sql.raw("SET LOCAL statement_timeout = '15s'"));
    const targets = await resolveMessageTargets(tx, roomId, sender, text, options, clientMessageId);
    if ("replay" in targets) return targets.replay;
    const { replyToNumber, threadRootNumber } = targets;

    const inserted = await insertMessageRow(
      tx, roomId, sender, text, options, promptKind, clientMessageId, replyToNumber, threadRootNumber,
    );
    if ("replay" in inserted) return inserted.replay;
    const { createdMessage } = inserted;
    await attachMessageUploads(tx, roomId, createdMessage, attachmentRefs, options);
    const createdMessageIsPromptOnly = isPromptOnlyAgentMessage(createdMessage.text, promptKind);
    if (createdMessageIsPromptOnly) {
      await tx
        .delete(messages)
        .where(
          and(
            eq(messages.room_id, roomId),
            eq(messages.sender, sender),
            eq(messages.agent_prompt_kind, "auto"),
            sql`BTRIM(${messages.text}) = ''`,
            sql`${messages.number} < ${createdMessage.number}`,
          ),
        );
    }

    const addressedTo = options?.addressed_to ?? null;
    let notificationEnqueueDurationMs = 0;
    if (!createdMessageIsPromptOnly && !addressedTo) {
      const notificationEnqueueStartedAtMs = Date.now();
      await enqueueDesktopPushNotifications(tx, createdMessage, {
        notify_account_ids: options?.notify_account_ids,
        recents_account_ids: options?.recents_account_ids,
      });
      notificationEnqueueDurationMs = Date.now() - notificationEnqueueStartedAtMs;
    }

    if (options?.with_created_message_in_transaction) {
      await options.with_created_message_in_transaction(tx, createdMessage);
    }

    // Send-time routing snapshot: resolve active worker sessions in this room and insert queued receipts
    const routingStartedAtMs = Date.now();
    const untrustedExternalEvent = isUntrustedExternalActivationSource(createdMessage.source);
    const taskOwnerFollowUp = !untrustedExternalEvent && !addressedTo
      && isTaskOwnerFollowUpMessageText(createdMessage.text);
    const leases = taskOwnerFollowUp
      ? await getBoundedActiveWorkLeaseOwners(tx, roomId)
      : [];

    let replyToMessage: {
      sender: string;
      text: string;
      source?: string;
      publisher_agent_key?: string | null;
      publisher_agent_session_id?: string | null;
      publisher_account_id?: string | null;
      visibility?: string | null;
      rental_session_id?: string | null;
    } | null = null;
    if (replyToNumber) {
      const [foundReply] = await tx
        .select({
          sender: messages.sender,
          text: messages.text,
          source: messages.source,
          publisher_agent_key: messages.publisher_agent_key,
          publisher_agent_session_id: messages.publisher_agent_session_id,
          publisher_account_id: messages.publisher_account_id,
          visibility: messages.visibility,
          rental_session_id: messages.rental_session_id,
        })
        .from(messages)
        .where(and(eq(messages.room_id, roomId), eq(messages.number, replyToNumber)))
        .limit(1);
      if (foundReply) replyToMessage = {
        sender: foundReply.sender,
        text: foundReply.text,
        source: foundReply.source ?? undefined,
        publisher_agent_key: foundReply.publisher_agent_key,
        publisher_agent_session_id: foundReply.publisher_agent_session_id,
        publisher_account_id: foundReply.publisher_account_id,
        visibility: foundReply.visibility,
        rental_session_id: foundReply.rental_session_id,
      };
    }

    const routingThreadRootNumber = createdMessage.thread_root_number || createdMessage.number;
    const threadRootId = `msg_${routingThreadRootNumber}`;
    let threadRoutingProjection: ThreadRoutingProjection = {
      exactMembers: new Map(),
      legacyAliases: new Map(),
    };
    const messageForRouting = {
      id: `msg_${createdMessage.number}`,
      sender: createdMessage.sender,
      text: createdMessage.text,
      source: createdMessage.source,
      reply_to: replyToMessage,
      thread_root_id: threadRootId,
      thread: {
        root_message_id: threadRootId,
        // Display participants are intentionally not hydrated on the hot
        // write path. Exact membership comes from the indexed projection.
        participants: [],
      },
    };

    // Only address resolution needs the complete room population. Exact
    // thread, reply, and lease authority already yields durable candidates;
    // querying just those keys/sessions avoids enumerating a large room twice
    // for an ordinary one-recipient continuation.
    const routingShape = createGlobalAgentAddressResolver([])(messageForRouting);
    // Replying to a human's message (often your own, to nudge the room) does
    // not address any agent: it stays in the untagged fallback lane instead
    // of the reply-target lane, which has no agent to wake.
    const replyToIsHuman = replyToMessage !== null
      && !replyToMessage.publisher_agent_key
      && replyToMessage.source !== "agent";
    const humanConversationEligible = createdMessage.source === "browser"
      && Boolean(createdMessage.publisher_account_id) && !createdMessage.publisher_agent_key
      && !routingShape.broadcast && !routingShape.hasMention
      && (createdMessage.reply_to_number === null || replyToIsHuman)
      && createdMessage.thread_root_number === null;
    const candidateAgentKeys = new Set<string>();
    const candidateSessionIds = new Set<string>();
    if (replyToMessage?.publisher_agent_key && replyToMessage.publisher_account_id) {
      candidateAgentKeys.add(replyToMessage.publisher_agent_key);
      if (replyToMessage.publisher_agent_session_id) {
        candidateSessionIds.add(replyToMessage.publisher_agent_session_id);
      }
    }
    let leaseNeedsCompletePopulation = false;
    for (const lease of leases) {
      if (lease.agent_key) candidateAgentKeys.add(lease.agent_key);
      if (lease.agent_session_id) candidateSessionIds.add(lease.agent_session_id);
      if (!lease.agent_key && !lease.agent_session_id) leaseNeedsCompletePopulation = true;
    }
    const needsCompletePopulation = humanConversationEligible
      || routingShape.broadcast
      || routingShape.hasMention
      || createdMessage.thread_root_number !== null
      || (
        replyToMessage?.source === "agent"
        && !replyToMessage.publisher_agent_key
        // A threaded legacy reply target is already resolved globally by the
        // participant projection above. Top-level quotes still need the full
        // room alias population to establish uniqueness.
        && !createdMessage.thread_root_number
      )
      || (createdMessage.source === "agent" && !createdMessage.publisher_agent_key)
      || leaseNeedsCompletePopulation;
    const candidateKeys = [...candidateAgentKeys];
    const candidateSessions = [...candidateSessionIds];
    // Keep candidate lookup to O(1) PostgreSQL bind parameters. Expanding a
    // projected 65k+ durable-key set through inArray() exceeds the wire
    // protocol's 65,535 parameter ceiling before the active-session bound can
    // fail closed.
    const candidateKeyCondition = candidateKeys.length > 0
      ? sql`${room_agent_sessions.agent_key} IN (
          SELECT value
            FROM jsonb_array_elements_text(${JSON.stringify(candidateKeys)}::jsonb)
        )`
      : undefined;
    const candidateSessionCondition = candidateSessions.length > 0
      ? sql`${room_agent_sessions.session_id} IN (
          SELECT value
            FROM jsonb_array_elements_text(${JSON.stringify(candidateSessions)}::jsonb)
        )`
      : undefined;
    const candidateCondition = candidateKeyCondition && candidateSessionCondition
      ? or(
          candidateKeyCondition,
          candidateSessionCondition,
        )
      : candidateKeyCondition ?? candidateSessionCondition;
    const activeSessions = !untrustedExternalEvent && !addressedTo && (needsCompletePopulation || candidateCondition)
      ? await tx
          .select({
            session_id: room_agent_sessions.session_id,
            actor_label: room_agent_sessions.actor_label,
            agent_key: room_agent_sessions.agent_key,
            agent_instance_id: room_agent_sessions.agent_instance_id,
            display_name: room_agent_sessions.display_name,
            session_kind: room_agent_sessions.session_kind,
            owner_account_id: room_agent_sessions.owner_account_id,
            created_at: room_agent_sessions.created_at,
            last_seen_at: room_agent_sessions.last_seen_at,
          })
          .from(room_agent_sessions)
          .where(
            and(
              eq(room_agent_sessions.room_id, roomId),
              eq(room_agent_sessions.session_kind, "worker"),
              sql`${room_agent_sessions.ended_at} IS NULL`,
              needsCompletePopulation ? undefined : candidateCondition,
            )
          )
          // A stable order for the bound below and for routing identities.
          .orderBy(asc(room_agent_sessions.created_at), asc(room_agent_sessions.session_id))
          .limit(MAX_ACTIVE_ROUTING_SESSIONS + 1)
      : [];

    if (activeSessions.length > MAX_ACTIVE_ROUTING_SESSIONS) {
      throw new RequestValidationError("Room has too many active worker sessions to route a message safely.");
    }

    const reachableAgentKeys = new Set<string>();
    let connectedSessionIds: ReadonlySet<string> = new Set<string>();
    // Connections settle two questions: which agent a duplicated name means,
    // and which session answers for an agent that has several. The second
    // needs only the sessions of agents that have more than one.
    const sessionCountByAgentKey = new Map<string, number>();
    for (const session of activeSessions) {
      sessionCountByAgentKey.set(session.agent_key, (sessionCountByAgentKey.get(session.agent_key) ?? 0) + 1);
    }
    const sessionsNeedingConnections = routingShape.hasMention
      ? activeSessions
      : activeSessions.filter((session) => (sessionCountByAgentKey.get(session.agent_key) ?? 0) > 1);
    if (sessionsNeedingConnections.length > 0) {
      const connections = await getSessionConnections(
        tx,
        roomId,
        sessionsNeedingConnections.map((session) => session.session_id),
      );
      connectedSessionIds = connections.connected;
      if (routingShape.hasMention) {
        for (const session of activeSessions) {
          if (connections.reachable.has(session.session_id)) {
            reachableAgentKeys.add(session.agent_key);
          }
        }
      }
    }

    if (createdMessage.thread_root_number && activeSessions.length > 0) {
      threadRoutingProjection = await getMessageThreadRoutingProjection(
        tx,
        roomId,
        [routingThreadRootNumber],
        {
          activeIdentities: activeSessions.map((session) => ({
            actor_label: session.actor_label,
            agent_key: session.agent_key,
            agent_instance_id: session.agent_instance_id,
            agent_session_id: session.session_id,
            display_name: session.display_name,
            session_kind: session.session_kind,
            owner_account_id: session.owner_account_id,
          })),
        },
      );
    }

    let receiptCount = 0;
    let recipientAgentKeys: readonly string[] = [];
    let recipientAgentTargets: readonly MessageRecipientAgentTarget[] = [];
    let mentionNotices: readonly MessageMentionNotice[] = [];

    if (activeSessions.length > 0) {
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
    }

    if (addressedTo) {
      const addressed = await routeAddressedMessage(tx, roomId, createdMessage, addressedTo);
      releasedReplyTurns.push(...await releaseAgentReplyTurnHoldsTx(
        tx,
        roomId,
        addressed.map((target) => target.agent_key),
      ));
      receiptCount = addressed.length;
      recipientAgentKeys = addressed.map((target) => target.agent_key);
      recipientAgentTargets = addressed;
    }

    // Notification fan-out and worker routing both stay synchronous and atomic
    // with the message. Account for their combined hot-path cost so rooms with
    // no live worker sessions do not hide a slow notification enqueue.
    const routingDurationMs = Date.now() - routingStartedAtMs;
    const sendTimeFanoutDurationMs = notificationEnqueueDurationMs + routingDurationMs;
    if (sendTimeFanoutDurationMs > 250) {
      console.warn(
        `[message send-time fan-out] slow fan-out for ${roomId}: ${sendTimeFanoutDurationMs}ms`
        + ` (${notificationEnqueueDurationMs}ms notifications, ${routingDurationMs}ms routing,`
        + ` ${activeSessions.length} active sessions, ${receiptCount} receipts)`,
      );
    }

    // The canonical reply transition is server-owned and atomic with the
    // reply's creation: any worker publication that answers an earlier message
    // — an explicit reply_to, or a supervised daemon publication carrying its
    // reply-namespace idempotency id — marks that agent's receipt replied.
    // Supervised turns never call self-report endpoints, so this is the only
    // path that can move their receipts.
    const publisherAgentKey = createdMessage.publisher_agent_key;
    if (publisherAgentKey) {
      const replyTargetNumbers = new Set<number>();
      if (createdMessage.reply_to_number) replyTargetNumbers.add(createdMessage.reply_to_number);
      const supervisedTarget = parseSupervisedReplySourceNumber(clientMessageId);
      if (supervisedTarget) replyTargetNumbers.add(supervisedTarget);
      for (const targetNumber of replyTargetNumbers) {
        const unresolved = await tx
          .select({
            id: message_agent_receipts.id,
            receipt_state: message_agent_receipts.receipt_state,
            turn_position: message_agent_receipts.turn_position,
          })
          .from(message_agent_receipts)
          .where(and(
            eq(message_agent_receipts.message_room_id, roomId),
            eq(message_agent_receipts.message_number, targetNumber),
            eq(message_agent_receipts.agent_key, publisherAgentKey),
            inArray(message_agent_receipts.receipt_state, ["queued", "responding", "retrying", "blocked", "no_reply", "unavailable"]),
          ));
        for (const receipt of unresolved) {
          // Compare-and-set: if a concurrent transition won between the read
          // and this write, record nothing — an event may only describe a
          // state change that actually happened.
          const applied = await tx
            .update(message_agent_receipts)
            .set({
              receipt_state: "replied",
              // The committed reply IS the canonical answer: stamp its number
              // so Message info can link "View reply" even for supervised
              // publications, which never set reply_to.
              reply_message_number: createdMessage.number,
              updated_at: createdMessage.timestamp,
            })
            .where(and(
              eq(message_agent_receipts.id, receipt.id),
              eq(message_agent_receipts.receipt_state, receipt.receipt_state),
            ))
            .returning({ id: message_agent_receipts.id });
          if (applied.length === 0) continue;
          await tx.insert(message_agent_receipt_events).values({
            id: `rcpt_evt_${randomUUID().replace(/-/g, "")}`,
            receipt_id: receipt.id,
            message_room_id: roomId,
            message_number: targetNumber,
            from_state: receipt.receipt_state,
            to_state: "replied",
            actor_session_id: createdMessage.publisher_agent_session_id,
            timestamp: createdMessage.timestamp,
          });
          repliedReceiptTargets.add(targetNumber);
          // This agent's turn is done: the next ready position may now see
          // the message, with this reply already in its context.
          if (receipt.turn_position !== null) {
            releasedReplyTurns.push(...await finishReplyTurnsTx(tx, roomId, [{
              message_number: targetNumber,
              agent_key: publisherAgentKey,
            }]));
          }
        }
      }
    }

    return hydrateCreatedMessage(roomId, {
      messageRow: createdMessage,
      created: true,
      recipientAgentKeys,
      recipientAgentTargets,
      mentionNotices,
    }, options, tx);
  });
  // Only after commit, and only the released agents' workers.
  queueReplyTurnWakes(releasedReplyTurns);
  if (repliedReceiptTargets.size > 0) {
    // Dynamic import avoids a module cycle; room-level so the shared stream
    // never enumerates ids that may be concealed from some participants.
    void import("../../server/message-info-events.js").then(({ queueMessageInfoInvalidation }) => {
      queueMessageInfoInvalidation(roomId, null);
    }).catch((error) => {
      console.error(`[room messages] failed receipt invalidation for ${roomId}`, error);
    });
  }
  return result;
}

async function routeAddressedMessage(
  tx: MessageCreateTransaction,
  roomId: string,
  message: MessageRow,
  addressedTo: NonNullable<AddMessageOptions["addressed_to"]>,
): Promise<MessageRecipientAgentTarget[]> {
  const sessions = await tx
    .select({
      session_id: room_agent_sessions.session_id,
      actor_label: room_agent_sessions.actor_label,
      agent_key: room_agent_sessions.agent_key,
      owner_account_id: room_agent_sessions.owner_account_id,
      created_at: room_agent_sessions.created_at,
      last_seen_at: room_agent_sessions.last_seen_at,
      ended_at: room_agent_sessions.ended_at,
    })
    .from(room_agent_sessions)
    .where(and(
      eq(room_agent_sessions.room_id, roomId),
      eq(room_agent_sessions.agent_key, addressedTo.agent_key),
      eq(room_agent_sessions.session_kind, "worker"),
    ))
    .orderBy(sql`${room_agent_sessions.ended_at} IS NULL DESC`, sql`${room_agent_sessions.ended_at} DESC NULLS FIRST`)
    .limit(MAX_ACCOUNT_ROUTING_TARGETS + 1);
  const live = sessions.filter((session) => session.ended_at === null);
  let session: (typeof sessions)[number] | undefined;
  if (live.length > 0) {
    const connections = live.length > 1
      ? (await getSessionConnections(tx, roomId, live.map((candidate) => candidate.session_id))).connected
      : new Set<string>();
    session = chooseAnsweringSession(live, connections);
  } else {
    session = sessions[0];
  }
  if (!session) return [];
  await insertMessageReceiptRows(tx, [{
    id: `rcpt_${randomUUID().replace(/-/g, "")}`,
    message_room_id: roomId,
    message_number: message.number,
    room_id: roomId,
    agent_session_id: session.session_id,
    agent_key: addressedTo.agent_key,
    actor_label: session.actor_label,
    activation_reason: addressedTo.reason,
    receipt_state: "queued",
    created_at: message.timestamp,
    updated_at: message.timestamp,
  }]);
  return [{
    agent_key: addressedTo.agent_key,
    agent_session_id: session.session_id,
    owner_account_id: session.owner_account_id,
  }];
}

export async function addMessage(
  roomId: string,
  sender: string,
  text: string,
  options?: AddMessageOptions,
): Promise<Message> {
  const result = await addMessageWithCreateStatus(roomId, sender, text, options);
  return result.message;
}

/**
 * Supervised daemon publications carry a reply-namespace idempotency id:
 *   supervised-room:<entry>:<source-message>:reply:v1
 *   supervised-room:<entry>:<room>:<source-message>:reply:v1
 * Only this exact shape identifies a reply target; arbitrary client ids never
 * influence receipt state.
 */
export { parseSupervisedReplySourceNumber };

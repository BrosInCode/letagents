/**
 * Rental Room Projection — p1.4
 *
 * Implements §8.4: the session-scoped filtered view visible to
 * the provider agent.
 *
 * Responsibilities:
 *   provisionRentalRoom  — creates a rental room, links it to the
 *                          session, and adds the provider agent as
 *                          a rental_participant.
 *   projectMessagesForRental — returns only rental-visible messages
 *                              for a given session/room.
 *   projectActivityForRental — returns verified + rental-visible
 *                              activity events for a given session.
 *   setMessageVisibility — marks a message as rental_visible or
 *                          renter_only.
 *   getRentalContext — returns the full rental projection context
 *                     (task prompt, scope, continuity, activity, messages).
 *
 * The projection does NOT copy messages to a separate room. Instead,
 * it uses the visibility column on messages + the rental_session_id
 * column to filter the existing room's message stream.
 *
 * Spec §8.4, §22.2.
 */

import { eq, and, desc, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  rooms,
  participants,
  messages,
  rental_sessions,
  rental_activity_events,
} from "../db/schema.js";
import { isRentalParticipantProvisionableStatus } from "./room-provisioning-policy.js";

// ===== ID helpers =====

function generateRoomId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `rroom_${timestamp}_${random}`;
}

function generateParticipantId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `rpart_${timestamp}_${random}`;
}

// ===== Types =====

export interface ProvisionRentalRoomInput {
  sessionId: string;
  /** The parent room the renter is working in. */
  parentRoomId: string;
  /** Provider's display name in the rental room. */
  providerDisplayName: string;
  /** Provider's GitHub login (optional). */
  providerGithubLogin?: string;
  /** Provider's GitHub ID (optional). */
  providerGithubId?: string;
}

export interface ProvisionRentalRoomForProviderInput extends ProvisionRentalRoomInput {
  providerAccountId: string;
}

export interface RentalRoomResult {
  roomId: string;
  participantId: string;
  session: typeof rental_sessions.$inferSelect;
}

export interface ProjectedMessage {
  number: number;
  room_id: string;
  sender: string;
  text: string;
  agent_prompt_kind: string | null;
  source: string | null;
  visibility: string | null;
  rental_session_id: string | null;
  timestamp: string;
}

export interface ProjectedActivity {
  id: string;
  session_id: string;
  room_id: string;
  event_type: string;
  source: string;
  verified: boolean;
  visibility: string;
  payload: unknown;
  created_at: Date;
}

export interface RentalContext {
  session: typeof rental_sessions.$inferSelect;
  messages: ProjectedMessage[];
  activity: ProjectedActivity[];
}

// ===== Service functions =====

/**
 * Provision a rental room for an accepted session.
 *
 * Steps:
 * 1. Verify the session exists and is in "accepted" status
 * 2. Create a rental room record (child of the parent room)
 * 3. Add the provider agent as a rental_participant
 * 4. Update the session with the room_id
 * 5. Transition session status to "provisioning"
 *
 * Returns the created room ID, participant ID, and updated session.
 */
export async function provisionRentalRoom(
  input: ProvisionRentalRoomInput
): Promise<RentalRoomResult> {
  const { sessionId, parentRoomId, providerDisplayName } = input;

  return db.transaction(async (tx) => {
    const ensureParticipant = async (roomId: string): Promise<string> => {
      const [existing] = await tx
        .select({ id: participants.id })
        .from(participants)
        .where(
          and(
            eq(participants.room_id, roomId),
            eq(participants.role, "rental_participant"),
          ),
        )
        .limit(1);
      if (existing) return existing.id;

      const participantId = generateParticipantId();
      await tx.insert(participants).values({
        id: participantId,
        room_id: roomId,
        display_name: providerDisplayName,
        github_login: input.providerGithubLogin ?? null,
        github_id: input.providerGithubId ?? null,
        role: "rental_participant",
        created_at: new Date().toISOString(),
      });
      return participantId;
    };

    // Lock the session row so concurrent provision attempts serialize around
    // the accepted -> provisioning transition and cannot create duplicate rooms.
    const [session] = await tx
      .select()
      .from(rental_sessions)
      .where(eq(rental_sessions.id, sessionId))
      .for("update");

    if (!session) {
      throw new Error("session_not_found");
    }

    if (!isRentalParticipantProvisionableStatus(session.status)) {
      throw new Error(
        `invalid_status: session must be accepted to provision, got ${session.status}`
      );
    }

    if (session.room_id) {
      return {
        roomId: session.room_id,
        participantId: await ensureParticipant(session.room_id),
        session,
      };
    }

    const focusKey = `rental:${sessionId}`;
    const [existingRoom] = await tx
      .select({ id: rooms.id })
      .from(rooms)
      .where(
        and(
          eq(rooms.parent_room_id, parentRoomId),
          eq(rooms.focus_key, focusKey),
        ),
      )
      .limit(1);

    const roomId = existingRoom?.id ?? generateRoomId();
    const now = new Date().toISOString();

    if (!existingRoom) {
      await tx.insert(rooms).values({
        id: roomId,
        display_name: `Rental: ${session.task_title}`,
        kind: "focus",
        parent_room_id: parentRoomId,
        focus_key: focusKey,
        focus_status: "active",
        focus_parent_visibility: "summary_only",
        focus_activity_scope: "task_and_branch",
        created_at: now,
      });
    }

    const participantId = await ensureParticipant(roomId);

    // 4+5. Update session with room_id and advance to provisioning
    const [updated] = await tx
      .update(rental_sessions)
      .set({
        room_id: roomId,
        status: "provisioning",
        updated_at: new Date(),
      })
      .where(eq(rental_sessions.id, sessionId))
      .returning();

    if (!updated) {
      throw new Error("session_not_found");
    }

    return {
      roomId,
      participantId,
      session: updated,
    };
  });
}

/**
 * Provider-scoped wrapper for the route layer. This keeps the public
 * provision endpoint from leaking whether another provider owns a session.
 */
export async function provisionRentalRoomForProvider(
  input: ProvisionRentalRoomForProviderInput,
): Promise<RentalRoomResult | null> {
  const [session] = await db
    .select({ id: rental_sessions.id })
    .from(rental_sessions)
    .where(
      and(
        eq(rental_sessions.id, input.sessionId),
        eq(rental_sessions.provider_account_id, input.providerAccountId),
      ),
    );
  if (!session) return null;
  return provisionRentalRoom(input);
}

/**
 * Project messages for a rental participant.
 *
 * Only returns messages where:
 *   - visibility = 'rental_visible', OR
 *   - rental_session_id matches the session (sent by/for the rental)
 *
 * Per §8.4, the projection does NOT include:
 *   - Messages with no visibility tag (null = not rental-visible by default)
 *   - Messages marked 'renter_only' or 'internal'
 *   - Unrelated messages from other participants
 *
 * Results ordered by message number ascending (chronological).
 */
export async function projectMessagesForRental(
  roomId: string,
  sessionId: string,
  opts?: { limit?: number; afterNumber?: number }
): Promise<ProjectedMessage[]> {
  const limit = opts?.limit ?? 200;

  // Projection predicate (§8.4):
  // A message is visible to the provider agent iff:
  //   1. visibility = 'rental_visible' (hides renter_only/internal — enforces hide)
  //   2. AND (rental_session_id = this session OR rental_session_id IS NULL)
  //      (prevents cross-session leak — messages from other sessions stay hidden)
  const visibilityPredicate = sql`
    ${messages.visibility} = 'rental_visible'
    AND (
      ${messages.rental_session_id} = ${sessionId}
      OR ${messages.rental_session_id} IS NULL
    )
  `;

  let query = db
    .select({
      number: messages.number,
      room_id: messages.room_id,
      sender: messages.sender,
      text: messages.text,
      agent_prompt_kind: messages.agent_prompt_kind,
      source: messages.source,
      visibility: messages.visibility,
      rental_session_id: messages.rental_session_id,
      timestamp: messages.timestamp,
    })
    .from(messages)
    .where(
      and(
        eq(messages.room_id, roomId),
        visibilityPredicate
      )
    )
    .orderBy(messages.number)
    .limit(limit);

  if (opts?.afterNumber !== undefined) {
    query = db
      .select({
        number: messages.number,
        room_id: messages.room_id,
        sender: messages.sender,
        text: messages.text,
        agent_prompt_kind: messages.agent_prompt_kind,
        source: messages.source,
        visibility: messages.visibility,
        rental_session_id: messages.rental_session_id,
        timestamp: messages.timestamp,
      })
      .from(messages)
      .where(
        and(
          eq(messages.room_id, roomId),
          sql`${messages.number} > ${opts.afterNumber}`,
          visibilityPredicate
        )
      )
      .orderBy(messages.number)
      .limit(limit);
  }

  return query;
}

/**
 * Project activity events for a rental participant.
 *
 * Only returns events that are:
 *   - For the given session
 *   - Visibility = 'rental_visible' (default for most event types)
 *   - Verified events get priority display
 *
 * Results ordered by created_at ascending.
 */
export async function projectActivityForRental(
  sessionId: string,
  opts?: { limit?: number; verifiedOnly?: boolean }
): Promise<ProjectedActivity[]> {
  const limit = opts?.limit ?? 100;

  const conditions = [
    eq(rental_activity_events.session_id, sessionId),
    eq(rental_activity_events.visibility, "rental_visible"),
  ];

  if (opts?.verifiedOnly) {
    conditions.push(eq(rental_activity_events.verified, true));
  }

  return db
    .select()
    .from(rental_activity_events)
    .where(and(...conditions))
    .orderBy(rental_activity_events.created_at)
    .limit(limit);
}

/**
 * Set the visibility of a message for rental projection.
 *
 * Used by the renter to explicitly share (or hide) messages
 * with the rented agent.
 */
export async function setMessageVisibility(
  roomId: string,
  messageNumber: number,
  visibility: "rental_visible" | "renter_only" | "internal",
  sessionId?: string
): Promise<boolean> {
  const result = await db
    .update(messages)
    .set({
      visibility,
      ...(sessionId ? { rental_session_id: sessionId } : {}),
    })
    .where(
      and(
        eq(messages.room_id, roomId),
        eq(messages.number, messageNumber)
      )
    )
    .returning({ number: messages.number });

  return result.length > 0;
}

/**
 * Get the full rental projection context for a session.
 *
 * This is the main entry point for the rented provider agent.
 * Returns the session metadata, projected messages, and
 * projected activity events.
 */
export async function getRentalContext(
  sessionId: string,
  accountId: string
): Promise<RentalContext | null> {
  // Verify session exists and account has access
  const [session] = await db
    .select()
    .from(rental_sessions)
    .where(eq(rental_sessions.id, sessionId));

  if (!session) return null;

  // Only renter or provider can access
  if (
    session.renter_account_id !== accountId &&
    session.provider_account_id !== accountId
  ) {
    return null;
  }

  // If session has no room yet, return session only
  if (!session.room_id) {
    return {
      session,
      messages: [],
      activity: [],
    };
  }

  const isProvider = session.provider_account_id === accountId;

  // Provider gets projected view; renter gets full view
  let projectedMessages: ProjectedMessage[];
  if (isProvider) {
    projectedMessages = await projectMessagesForRental(
      session.room_id,
      sessionId
    );
  } else {
    // Renter sees all messages in the room
    projectedMessages = await db
      .select({
        number: messages.number,
        room_id: messages.room_id,
        sender: messages.sender,
        text: messages.text,
        agent_prompt_kind: messages.agent_prompt_kind,
        source: messages.source,
        visibility: messages.visibility,
        rental_session_id: messages.rental_session_id,
        timestamp: messages.timestamp,
      })
      .from(messages)
      .where(eq(messages.room_id, session.room_id))
      .orderBy(messages.number)
      .limit(200);
  }

  const activity = await projectActivityForRental(sessionId);

  return {
    session,
    messages: projectedMessages,
    activity,
  };
}

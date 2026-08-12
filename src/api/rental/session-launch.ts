import { and, eq, inArray, isNull } from "drizzle-orm";

import {
  createSupervisorHostGrant,
  endRoomAgentSession,
  getAgentIdentityByCanonicalKey,
  revokeSupervisorHostGrant,
} from "../db.js";
import { db } from "../db/client.js";
import {
  accounts,
  rental_provider_hosts,
  rental_sessions,
  room_agent_sessions,
  supervisor_host_grants,
} from "../db/schema.js";
import { emitProjectMessage } from "../server/events.js";
import { emitActivityEvent } from "./activity-emitter.js";
import { SESSION_STARTED } from "./activity-event-types.js";
import { emitRentalProviderEvent } from "./provider-events.js";
import { isRentalHostFresh } from "./provider-hosts.js";
import { assertRentalRuntimeSelectionSafe } from "./runtime-policy.js";

const MAX_RENTAL_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

export async function revokeRentalLaunchAuthority(
  sessionId: string,
  providerAccountId: string,
): Promise<void> {
  const grants = await db.select().from(supervisor_host_grants).where(and(
    eq(supervisor_host_grants.rental_session_id, sessionId),
    eq(supervisor_host_grants.owner_account_id, providerAccountId),
    isNull(supervisor_host_grants.revoked_at),
  ));
  for (const grant of grants) {
    const [worker] = await db.select().from(room_agent_sessions).where(and(
      eq(room_agent_sessions.supervisor_grant_id, grant.grant_id),
      isNull(room_agent_sessions.ended_at),
    )).limit(1);
    if (worker) {
      await endRoomAgentSession({
        session_id: worker.session_id,
        owner_account_id: providerAccountId,
        supervisor_grant_id: grant.grant_id,
        supervisor_grant_fence: {
          grant_id: grant.grant_id,
          generation: grant.current_generation,
          token_version: grant.token_version,
        },
      });
    }
    await revokeSupervisorHostGrant({ grant_id: grant.grant_id, owner_account_id: providerAccountId });
  }
}

/** Terminal lifecycle routes may be called by either side, so resolve the
 * provider owner server-side before revoking every rental-scoped credential. */
export async function revokeRentalLaunchAuthorityForSession(sessionId: string): Promise<void> {
  const [session] = await db.select({ providerAccountId: rental_sessions.provider_account_id })
    .from(rental_sessions)
    .where(eq(rental_sessions.id, sessionId))
    .limit(1);
  if (!session) return;
  await revokeRentalLaunchAuthority(sessionId, session.providerAccountId);
}

export interface RentalLaunchAcknowledgement {
  launchAttempt: number;
  state: "provisioning" | "active" | "launch_failed";
  daemonEntryId?: string;
  roomAgentSessionId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export function rentalLaunchAcknowledgementPriorStates(
  requestedState: RentalLaunchAcknowledgement["state"],
): string[] {
  if (requestedState === "active") return ["provisioning"];
  if (requestedState === "provisioning") return ["pending", "provisioning"];
  return ["pending", "provisioning", "launch_failed"];
}

export function rentalLaunchAcknowledgementPriorStatuses(
  requestedState: RentalLaunchAcknowledgement["state"],
): Array<"accepted" | "provisioning"> {
  return requestedState === "active"
    ? ["provisioning"]
    : ["accepted", "provisioning"];
}

export async function isRentalSupervisorGrantActive(input: {
  rentalSessionId: string;
  providerAccountId: string;
  hostId: string;
}): Promise<boolean> {
  const [running] = await db.select({ id: rental_sessions.id })
    .from(rental_sessions)
    .innerJoin(rental_provider_hosts, eq(rental_provider_hosts.id, rental_sessions.provider_host_id))
    .where(and(
    eq(rental_sessions.id, input.rentalSessionId),
    eq(rental_sessions.provider_account_id, input.providerAccountId),
    eq(rental_provider_hosts.host_id, input.hostId),
    inArray(rental_sessions.status, ["accepted", "provisioning", "active", "blocked", "patch_review"]),
    inArray(rental_sessions.launch_state, ["pending", "provisioning", "active"]),
  )).limit(1);
  return Boolean(running);
}

function grantExpiry(session: typeof rental_sessions.$inferSelect): string {
  const requested = (session.time_limit_minutes ?? 30) * 60_000;
  return new Date(Date.now() + Math.min(MAX_RENTAL_GRANT_TTL_MS, requested + 10 * 60_000)).toISOString();
}

export async function createRentalLaunchAuthority(input: {
  sessionId: string;
  providerAccountId: string;
  agentKey: string;
}) {
  const [session] = await db.select().from(rental_sessions).where(and(
    eq(rental_sessions.id, input.sessionId),
    eq(rental_sessions.provider_account_id, input.providerAccountId),
  )).limit(1);
  if (!session) return null;
  if (!session.room_id || session.room_placement !== "direct_member") {
    throw new Error("direct_room_required");
  }
  if (session.status !== "accepted" && session.status !== "provisioning") {
    throw new Error("launch_not_authorized");
  }
  if (!session.provider_host_id || !session.selected_runtime || session.launch_attempt < 1) {
    throw new Error("launch_selection_required");
  }
  assertRentalRuntimeSelectionSafe(session.selected_runtime);
  if (session.launch_state !== "pending" && session.launch_state !== "provisioning") {
    throw new Error("launch_not_pending");
  }
  const [[host], agent] = await Promise.all([
    db.select().from(rental_provider_hosts).where(and(
      eq(rental_provider_hosts.id, session.provider_host_id),
      eq(rental_provider_hosts.provider_account_id, input.providerAccountId),
    )).limit(1),
    getAgentIdentityByCanonicalKey(input.agentKey),
  ]);
  if (!host || !host.enabled || !isRentalHostFresh(host.last_heartbeat_at)) {
    throw new Error("provider_host_unavailable");
  }
  if (!agent || agent.owner_account_id !== input.providerAccountId) {
    throw new Error("agent_identity_not_owned");
  }
  const created = await createSupervisorHostGrant({
    owner_account_id: input.providerAccountId,
    host_id: host.host_id,
    installation_id: host.installation_id,
    allowed_room_ids: [session.room_id],
    allowed_agent_keys: [agent.canonical_key],
    expires_at: grantExpiry(session),
    scope_key: `rental:${session.id}`,
    rental_session_id: session.id,
  });
  return {
    session,
    grant: {
      grant_id: created.grant.grant_id,
      generation: created.grant.current_generation,
      current_generation: created.grant.current_generation,
      token_version: created.grant.token_version,
      expires_at: created.grant.expires_at,
      supervisor_grant: created.token,
    },
  };
}

async function validateActiveWorker(
  session: typeof rental_sessions.$inferSelect,
  roomAgentSessionId: string,
  daemonEntryId: string,
) {
  const [worker] = await db.select().from(room_agent_sessions).where(and(
    eq(room_agent_sessions.session_id, roomAgentSessionId),
    eq(room_agent_sessions.room_id, session.room_id!),
    eq(room_agent_sessions.owner_account_id, session.provider_account_id),
    eq(room_agent_sessions.agent_instance_id, daemonEntryId),
    eq(room_agent_sessions.session_kind, "worker"),
    isNull(room_agent_sessions.ended_at),
  )).limit(1);
  if (!worker) throw new Error("rental_worker_not_ready");
  const [grant] = await db.select().from(supervisor_host_grants).where(and(
    eq(supervisor_host_grants.grant_id, worker.supervisor_grant_id ?? ""),
    eq(supervisor_host_grants.rental_session_id, session.id),
    isNull(supervisor_host_grants.revoked_at),
  )).limit(1);
  if (!grant || !grant.allowed_agent_keys.includes(worker.agent_key)) {
    throw new Error("rental_worker_grant_mismatch");
  }
  return worker;
}

async function publishInitialRentalTask(
  session: typeof rental_sessions.$inferSelect,
  worker: typeof room_agent_sessions.$inferSelect,
): Promise<string> {
  if (session.initial_task_message_id) return session.initial_task_message_id;
  const [renter] = await db.select().from(accounts)
    .where(eq(accounts.id, session.renter_account_id)).limit(1);
  const message = await emitProjectMessage(
    session.room_id!,
    renter?.display_name || renter?.login || "Renter",
    `@${worker.agent_key} ${session.task_prompt}`,
    {
      source: "rental_start",
      agent_prompt_kind: "inline",
      client_message_id: `rental:${session.id}:launch:${session.launch_attempt}:start`,
      account_id: session.renter_account_id,
    },
  );
  await db.update(rental_sessions).set({ initial_task_message_id: message.id })
    .where(and(
      eq(rental_sessions.id, session.id),
      isNull(rental_sessions.initial_task_message_id),
    ));
  return message.id;
}

export async function acknowledgeRentalLaunch(input: {
  sessionId: string;
  providerAccountId: string;
  acknowledgement: RentalLaunchAcknowledgement;
}) {
  const [session] = await db.select().from(rental_sessions).where(and(
    eq(rental_sessions.id, input.sessionId),
    eq(rental_sessions.provider_account_id, input.providerAccountId),
  )).limit(1);
  if (!session) return null;
  if (session.room_placement === "direct_member") {
    if (!session.selected_runtime) throw new Error("launch_selection_required");
    assertRentalRuntimeSelectionSafe(session.selected_runtime);
  }
  const ack = input.acknowledgement;
  if (ack.launchAttempt !== session.launch_attempt) throw new Error("launch_attempt_stale");
  if (session.status !== "accepted" && session.status !== "provisioning" && session.status !== "active") {
    throw new Error("launch_not_authorized");
  }
  assertRentalLaunchAcknowledgementMonotonic(session.launch_state, ack.state);
  if (session.daemon_entry_id && ack.daemonEntryId && session.daemon_entry_id !== ack.daemonEntryId) {
    throw new Error("daemon_entry_fence_lost");
  }

  let worker: typeof room_agent_sessions.$inferSelect | null = null;
  if (ack.state === "active") {
    if (!ack.daemonEntryId || !ack.roomAgentSessionId) throw new Error("active_launch_identity_required");
    worker = await validateActiveWorker(session, ack.roomAgentSessionId, ack.daemonEntryId);
  }

  const status = ack.state === "provisioning"
    ? "provisioning"
    : ack.state === "active"
      ? "active"
      : "accepted";
  let [updated] = await db.update(rental_sessions).set({
    status,
    launch_state: ack.state,
    daemon_entry_id: ack.daemonEntryId ?? session.daemon_entry_id,
    room_agent_session_id: ack.roomAgentSessionId ?? session.room_agent_session_id,
    launch_error_code: ack.state === "launch_failed" ? ack.errorCode?.slice(0, 120) ?? "launch_failed" : null,
    launch_error_message: ack.state === "launch_failed" ? ack.errorMessage?.slice(0, 1000) ?? null : null,
    started_at: ack.state === "active" ? session.started_at ?? new Date() : session.started_at,
    updated_at: new Date(),
  }).where(and(
    eq(rental_sessions.id, session.id),
    eq(rental_sessions.launch_attempt, ack.launchAttempt),
    inArray(
      rental_sessions.status,
      rentalLaunchAcknowledgementPriorStatuses(ack.state),
    ),
    inArray(
      rental_sessions.launch_state,
      rentalLaunchAcknowledgementPriorStates(ack.state),
    ),
  )).returning();
  if (!updated && ack.state === "active") {
    const [active] = await db.select().from(rental_sessions).where(and(
      eq(rental_sessions.id, session.id),
      eq(rental_sessions.launch_attempt, ack.launchAttempt),
      eq(rental_sessions.launch_state, "active"),
      eq(rental_sessions.daemon_entry_id, ack.daemonEntryId!),
      eq(rental_sessions.room_agent_session_id, ack.roomAgentSessionId!),
    )).limit(1);
    if (active && worker) {
      active.initial_task_message_id = await publishInitialRentalTask(active, worker);
      return active;
    }
  }
  if (!updated) {
    const [current] = await db.select({
      launchState: rental_sessions.launch_state,
      status: rental_sessions.status,
    })
      .from(rental_sessions)
      .where(and(
        eq(rental_sessions.id, session.id),
        eq(rental_sessions.launch_attempt, ack.launchAttempt),
      ))
      .limit(1);
    if (current && !rentalLaunchAcknowledgementPriorStatuses(ack.state).includes(
      current.status as "accepted" | "provisioning",
    ) && current.status !== "active") {
      throw new Error("launch_not_authorized");
    }
    assertRentalLaunchAcknowledgementMonotonic(current?.launchState ?? null, ack.state);
    throw new Error("launch_attempt_stale");
  }

  if (ack.state === "active" && worker) {
    const initialTaskMessageId = await publishInitialRentalTask(updated, worker);
    if (session.launch_state !== "active" && updated.room_id) {
      await emitActivityEvent({
        sessionId: updated.id,
        roomId: updated.room_id,
        eventType: SESSION_STARTED,
        source: "system",
        payload: { launch_attempt: updated.launch_attempt, room_agent_session_id: worker.session_id },
      });
    }
    updated.initial_task_message_id = initialTaskMessageId;
  }
  if (ack.state === "launch_failed") {
    await revokeRentalLaunchAuthority(session.id, input.providerAccountId);
  }
  await emitRentalProviderEvent({
    providerAccountId: input.providerAccountId,
    sessionId: session.id,
    kind: "launch.updated",
    payload: { state: ack.state, launchAttempt: ack.launchAttempt },
  }).catch(() => undefined);
  return updated;
}

export function assertRentalLaunchAcknowledgementMonotonic(
  currentState: string | null,
  requestedState: RentalLaunchAcknowledgement["state"],
): void {
  if (currentState === "active" && requestedState !== "active") {
    throw new Error("launch_already_active");
  }
  const allowed = requestedState === "active"
    ? ["provisioning", "active"]
    : rentalLaunchAcknowledgementPriorStates(requestedState);
  if (!currentState || !allowed.includes(currentState)) {
    throw new Error("launch_state_transition_invalid");
  }
}

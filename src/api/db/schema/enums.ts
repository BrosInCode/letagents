import { pgEnum } from "drizzle-orm/pg-core";
import {
  AGENT_PRESENCE_STATUSES,
  ROOM_AGENT_DELIVERY_TRANSPORTS,
  ROOM_AGENT_SESSION_KINDS,
} from "../../../shared/agent-presence.js";
import { ROOM_PARTICIPANT_KINDS } from "../../../shared/room-participant.js";

export const participantRoleEnum = pgEnum("participant_role", ["participant", "admin", "rental_participant"]);
export const roomParticipantKindEnum = pgEnum("room_participant_kind", ROOM_PARTICIPANT_KINDS);
export const taskStatusEnum = pgEnum("task_status", [
  "proposed",
  "accepted",
  "assigned",
  "in_progress",
  "blocked",
  "in_review",
  "merged",
  "done",
  "cancelled",
]);
export const agentPresenceStatusEnum = pgEnum("agent_presence_status", AGENT_PRESENCE_STATUSES);
export const roomAgentDeliveryTransportEnum = pgEnum(
  "room_agent_delivery_transport",
  ROOM_AGENT_DELIVERY_TRANSPORTS
);
export const roomAgentSessionKindEnum = pgEnum(
  "room_agent_session_kind",
  ROOM_AGENT_SESSION_KINDS
);
export const taskLeaseKindEnum = pgEnum("task_lease_kind", ["work", "review"]);
export const taskLeaseStatusEnum = pgEnum("task_lease_status", [
  "active",
  "released",
  "revoked",
  "expired",
]);
export const taskLockScopeEnum = pgEnum("task_lock_scope", ["room", "task"]);
export const taskLockReasonEnum = pgEnum("task_lock_reason", [
  "human_stop",
  "duplicate",
  "manager_pause",
  "revoked",
  "policy",
]);
export const coordinationDecisionEnum = pgEnum("coordination_decision", [
  "allow",
  "deny",
  "record",
]);

/**
 * Rental Activity Event Types — §9.4 Taxonomy
 *
 * V1 rental activity event types, organized by category.
 * Each event type is a string constant for use in the activity-emitter.
 *
 * Categories:
 *   session.*       — lifecycle transitions
 *   agent.*         — provider agent actions
 *   budget.*        — quota/LRT tracking
 *   context.*       — scope/exposure decisions
 *   search.*        — code search actions
 *   command.*       — shell/command execution
 *   edit.*          — code editing proposals
 *   patch.*         — patch submission
 *   patch_gate.*    — Patch Gate pipeline stages
 */

// ===== Session events =====
export const SESSION_STARTED = "session.started" as const;
export const SESSION_ACCEPTED = "session.accepted" as const;
export const SESSION_BLOCKED = "session.blocked" as const;
export const SESSION_COMPLETED = "session.completed" as const;
export const SESSION_CANCELLED = "session.cancelled" as const;
export const SESSION_SILENCE_NUDGE_SENT = "session.silence_nudge_sent" as const;
export const SESSION_LEASE_CREATED = "session.lease_created" as const;
export const SESSION_TEARDOWN_COMPLETED = "session.teardown_completed" as const;

// ===== Agent events =====
export const AGENT_JOINED = "agent.joined" as const;
export const AGENT_HEARTBEAT = "agent.heartbeat" as const;
export const AGENT_NOTE = "agent.note" as const;

// ===== Budget events =====
export const BUDGET_LEASE_STARTED = "budget.lease_started" as const;
export const BUDGET_RESERVED = "budget.reserved" as const;
export const BUDGET_RECONCILED = "budget.reconciled" as const;
export const BUDGET_WARNING = "budget.warning" as const;
export const BUDGET_EXHAUSTED = "budget.exhausted" as const;
export const BUDGET_METER_STALE = "budget.meter_stale" as const;
export const BUDGET_METER_RECOVERED = "budget.meter_recovered" as const;
export const BUDGET_EXTERNAL_USAGE_SUSPECTED = "budget.external_usage_suspected" as const;
export const BUDGET_EXTENSION_REQUESTED = "budget.extension_requested" as const;
export const BUDGET_EXTENSION_APPROVED = "budget.extension_approved" as const;
export const BUDGET_EXTENSION_DENIED = "budget.extension_denied" as const;

// ===== Context events =====
export const CONTEXT_SCOPE_SET = "context.scope_set" as const;
export const CONTEXT_FILE_EXPOSED = "context.file_exposed" as const;
export const CONTEXT_FILE_BLOCKED = "context.file_blocked" as const;
export const CONTEXT_SECRET_REDACTED = "context.secret_redacted" as const;
export const CONTEXT_SCOPE_DENIED = "context.scope_denied" as const;
export const CONTEXT_BASE_BRANCH_CHANGED = "context.base_branch_changed" as const;
export const CONTEXT_ACCESS_REQUESTED = "context.access_requested" as const;
export const CONTEXT_ACCESS_APPROVED = "context.access_approved" as const;
export const CONTEXT_ACCESS_DENIED = "context.access_denied" as const;

// ===== Search events =====
export const SEARCH_RUN = "search.run" as const;

// ===== Command events =====
export const COMMAND_REQUESTED = "command.requested" as const;
export const COMMAND_ALLOWED = "command.allowed" as const;
export const COMMAND_BLOCKED = "command.blocked" as const;
export const COMMAND_RUN = "command.run" as const;
export const COMMAND_OUTPUT = "command.output" as const;
export const COMMAND_TIMED_OUT = "command.timed_out" as const;

// ===== Edit events =====
export const EDIT_PROPOSED = "edit.proposed" as const;

// ===== Patch events =====
export const PATCH_PROPOSED = "patch.proposed" as const;
export const PATCH_APPROVED = "patch.approved" as const;
export const PATCH_CHANGES_REQUESTED = "patch.changes_requested" as const;

// ===== Lane events (D4 amendment — renter quota lane lifecycle) =====
export const LANE_EXHAUSTED = "lane.exhausted" as const;
export const LANE_RECOVERED = "lane.recovered" as const;

// ===== Patch Gate events =====
export const PATCH_GATE_STARTED = "patch_gate.started" as const;
export const PATCH_GATE_SCOPE_PASSED = "patch_gate.scope_passed" as const;
export const PATCH_GATE_SECRET_PASSED = "patch_gate.secret_passed" as const;
export const PATCH_GATE_RISK_FLAGGED = "patch_gate.risk_flagged" as const;
export const PATCH_GATE_TESTS_STARTED = "patch_gate.tests_started" as const;
export const PATCH_GATE_TESTS_PASSED = "patch_gate.tests_passed" as const;
export const PATCH_GATE_TESTS_FAILED = "patch_gate.tests_failed" as const;
export const PATCH_GATE_TIMED_OUT = "patch_gate.timed_out" as const;
export const PATCH_GATE_APPLY_FAILED = "patch_gate.apply_failed" as const;

/**
 * All event types as a union type for exhaustiveness checking.
 */
export type RentalActivityEventType =
  | typeof SESSION_STARTED
  | typeof SESSION_ACCEPTED
  | typeof SESSION_BLOCKED
  | typeof SESSION_COMPLETED
  | typeof SESSION_CANCELLED
  | typeof SESSION_SILENCE_NUDGE_SENT
  | typeof SESSION_LEASE_CREATED
  | typeof SESSION_TEARDOWN_COMPLETED
  | typeof AGENT_JOINED
  | typeof AGENT_HEARTBEAT
  | typeof AGENT_NOTE
  | typeof BUDGET_LEASE_STARTED
  | typeof BUDGET_RESERVED
  | typeof BUDGET_RECONCILED
  | typeof BUDGET_WARNING
  | typeof BUDGET_EXHAUSTED
  | typeof BUDGET_METER_STALE
  | typeof BUDGET_METER_RECOVERED
  | typeof BUDGET_EXTERNAL_USAGE_SUSPECTED
  | typeof BUDGET_EXTENSION_REQUESTED
  | typeof BUDGET_EXTENSION_APPROVED
  | typeof BUDGET_EXTENSION_DENIED
  | typeof CONTEXT_SCOPE_SET
  | typeof CONTEXT_FILE_EXPOSED
  | typeof CONTEXT_FILE_BLOCKED
  | typeof CONTEXT_SECRET_REDACTED
  | typeof CONTEXT_SCOPE_DENIED
  | typeof CONTEXT_BASE_BRANCH_CHANGED
  | typeof CONTEXT_ACCESS_REQUESTED
  | typeof CONTEXT_ACCESS_APPROVED
  | typeof CONTEXT_ACCESS_DENIED
  | typeof SEARCH_RUN
  | typeof COMMAND_REQUESTED
  | typeof COMMAND_ALLOWED
  | typeof COMMAND_BLOCKED
  | typeof COMMAND_RUN
  | typeof COMMAND_OUTPUT
  | typeof COMMAND_TIMED_OUT
  | typeof EDIT_PROPOSED
  | typeof PATCH_PROPOSED
  | typeof PATCH_APPROVED
  | typeof PATCH_CHANGES_REQUESTED
  | typeof LANE_EXHAUSTED
  | typeof LANE_RECOVERED
  | typeof PATCH_GATE_STARTED
  | typeof PATCH_GATE_SCOPE_PASSED
  | typeof PATCH_GATE_SECRET_PASSED
  | typeof PATCH_GATE_RISK_FLAGGED
  | typeof PATCH_GATE_TESTS_STARTED
  | typeof PATCH_GATE_TESTS_PASSED
  | typeof PATCH_GATE_TESTS_FAILED
  | typeof PATCH_GATE_TIMED_OUT
  | typeof PATCH_GATE_APPLY_FAILED;

/**
 * All event type strings as a readonly array for runtime enumeration.
 */
export const ALL_ACTIVITY_EVENT_TYPES: readonly RentalActivityEventType[] = [
  SESSION_STARTED,
  SESSION_ACCEPTED,
  SESSION_BLOCKED,
  SESSION_COMPLETED,
  SESSION_CANCELLED,
  SESSION_SILENCE_NUDGE_SENT,
  SESSION_LEASE_CREATED,
  SESSION_TEARDOWN_COMPLETED,
  AGENT_JOINED,
  AGENT_HEARTBEAT,
  AGENT_NOTE,
  BUDGET_LEASE_STARTED,
  BUDGET_RESERVED,
  BUDGET_RECONCILED,
  BUDGET_WARNING,
  BUDGET_EXHAUSTED,
  BUDGET_METER_STALE,
  BUDGET_METER_RECOVERED,
  BUDGET_EXTERNAL_USAGE_SUSPECTED,
  BUDGET_EXTENSION_REQUESTED,
  BUDGET_EXTENSION_APPROVED,
  BUDGET_EXTENSION_DENIED,
  CONTEXT_SCOPE_SET,
  CONTEXT_FILE_EXPOSED,
  CONTEXT_FILE_BLOCKED,
  CONTEXT_SECRET_REDACTED,
  CONTEXT_SCOPE_DENIED,
  CONTEXT_BASE_BRANCH_CHANGED,
  CONTEXT_ACCESS_REQUESTED,
  CONTEXT_ACCESS_APPROVED,
  CONTEXT_ACCESS_DENIED,
  SEARCH_RUN,
  COMMAND_REQUESTED,
  COMMAND_ALLOWED,
  COMMAND_BLOCKED,
  COMMAND_RUN,
  COMMAND_OUTPUT,
  COMMAND_TIMED_OUT,
  EDIT_PROPOSED,
  PATCH_PROPOSED,
  PATCH_APPROVED,
  PATCH_CHANGES_REQUESTED,
  LANE_EXHAUSTED,
  LANE_RECOVERED,
  PATCH_GATE_STARTED,
  PATCH_GATE_SCOPE_PASSED,
  PATCH_GATE_SECRET_PASSED,
  PATCH_GATE_RISK_FLAGGED,
  PATCH_GATE_TESTS_STARTED,
  PATCH_GATE_TESTS_PASSED,
  PATCH_GATE_TESTS_FAILED,
  PATCH_GATE_TIMED_OUT,
  PATCH_GATE_APPLY_FAILED,
] as const;

/**
 * Event source enum matching §19.3.
 */
export type RentalActivitySource =
  | "agent"
  | "tool"
  | "patch_gate"
  | "system"
  | "renter"
  | "provider";

/**
 * Visibility level for activity events.
 * Controls who can see the event in the rental room projection.
 */
export type RentalActivityVisibility =
  | "rental_visible"
  | "renter_only"
  | "provider_only"
  | "internal";

/**
 * Events that are auto-verified because they are tool-mediated
 * (the system can confirm they actually happened).
 */
export const AUTO_VERIFIED_EVENT_TYPES: ReadonlySet<RentalActivityEventType> =
  new Set([
    SESSION_STARTED,
    SESSION_ACCEPTED,
    SESSION_BLOCKED,
    SESSION_COMPLETED,
    SESSION_CANCELLED,
    SESSION_SILENCE_NUDGE_SENT,
    SESSION_LEASE_CREATED,
    SESSION_TEARDOWN_COMPLETED,
    AGENT_JOINED,
    AGENT_HEARTBEAT,
    BUDGET_LEASE_STARTED,
    BUDGET_RESERVED,
    BUDGET_RECONCILED,
    BUDGET_WARNING,
    BUDGET_EXHAUSTED,
    BUDGET_METER_STALE,
    BUDGET_METER_RECOVERED,
    BUDGET_EXTERNAL_USAGE_SUSPECTED,
    BUDGET_EXTENSION_REQUESTED,
    BUDGET_EXTENSION_APPROVED,
    BUDGET_EXTENSION_DENIED,
    CONTEXT_SCOPE_SET,
    CONTEXT_FILE_EXPOSED,
    CONTEXT_FILE_BLOCKED,
    CONTEXT_SECRET_REDACTED,
    CONTEXT_SCOPE_DENIED,
    CONTEXT_BASE_BRANCH_CHANGED,
    CONTEXT_ACCESS_REQUESTED,
    CONTEXT_ACCESS_APPROVED,
    CONTEXT_ACCESS_DENIED,
    SEARCH_RUN,
    COMMAND_REQUESTED,
    COMMAND_ALLOWED,
    COMMAND_BLOCKED,
    COMMAND_RUN,
    COMMAND_OUTPUT,
    COMMAND_TIMED_OUT,
    EDIT_PROPOSED,
    PATCH_PROPOSED,
    PATCH_APPROVED,
    PATCH_CHANGES_REQUESTED,
    LANE_EXHAUSTED,
    LANE_RECOVERED,
    PATCH_GATE_STARTED,
    PATCH_GATE_SCOPE_PASSED,
    PATCH_GATE_SECRET_PASSED,
    PATCH_GATE_RISK_FLAGGED,
    PATCH_GATE_TESTS_STARTED,
    PATCH_GATE_TESTS_PASSED,
    PATCH_GATE_TESTS_FAILED,
    PATCH_GATE_TIMED_OUT,
    PATCH_GATE_APPLY_FAILED,
  ]);

/**
 * Only agent.note is unverified by default — it comes from
 * the provider agent's self-report, not a tool-mediated action.
 */
export const UNVERIFIED_EVENT_TYPES: ReadonlySet<RentalActivityEventType> =
  new Set([AGENT_NOTE]);

/**
 * Default visibility for each event type.
 * Internal events are only visible to the system.
 * Most events default to "both" (visible to renter and provider).
 */
export function getDefaultVisibility(
  eventType: RentalActivityEventType
): RentalActivityVisibility {
  switch (eventType) {
    // Internal — system telemetry only
    case AGENT_HEARTBEAT:
    case BUDGET_METER_STALE:
    case BUDGET_METER_RECOVERED:
    case BUDGET_EXTERNAL_USAGE_SUSPECTED:
      return "internal";

    // Provider-only — not shown to renter
    case AGENT_NOTE:
      return "provider_only";

    // Renter-only — not shown to provider
    case SESSION_SILENCE_NUDGE_SENT:
      return "renter_only";

    // Rental-visible — visible to everyone in the rental session
    default:
      return "rental_visible";
  }
}

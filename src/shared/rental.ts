/**
 * Rental system types, enums, validation, and state machine.
 *
 * Pure TypeScript — no Node/Express dependencies.
 * Used by both the API server and the MCP server.
 */

// ─── Enums ──────────────────────────────────────────────────

export const RENTAL_LISTING_STATUSES = [
  "active",
  "paused",
  "exhausted",
  "retired",
] as const;

export type RentalListingStatus = (typeof RENTAL_LISTING_STATUSES)[number];

export const RENTAL_SESSION_STATUSES = [
  "requested",
  "accepted",
  "active",
  "paused",
  "completed",
  "cancelled",
  "expired",
  "disputed",
] as const;

export type RentalSessionStatus = (typeof RENTAL_SESSION_STATUSES)[number];

export const RENTAL_OUTPUT_TYPES = [
  "research_note",
  "comment",
  "draft_pr",
] as const;

export type RentalOutputType = (typeof RENTAL_OUTPUT_TYPES)[number];

export const RENTAL_TOKEN_EVENT_TYPES = [
  "heartbeat",
  "completion",
  "adjustment",
] as const;

export type RentalTokenEventType = (typeof RENTAL_TOKEN_EVENT_TYPES)[number];

/** Known IDE labels — must stay in sync with agent-identity.ts IDE_LABELS. */
export const RENTAL_IDE_LABELS = [
  "antigravity",
  "codex",
  "cursor",
  "claude-code",
  "windsurf",
] as const;

export type RentalIdeLabel = (typeof RENTAL_IDE_LABELS)[number];

// ─── State Machine ──────────────────────────────────────────

/**
 * Valid state transitions for rental sessions.
 *
 * v1: Manual accept only. No shortcut from requested → active.
 */
export const RENTAL_SESSION_TRANSITIONS: Record<RentalSessionStatus, readonly RentalSessionStatus[]> = {
  requested: ["accepted", "cancelled"],
  accepted: ["active", "cancelled"],
  active: ["paused", "completed", "expired", "cancelled", "disputed"],
  paused: ["active", "cancelled", "expired"],
  completed: [],
  cancelled: [],
  expired: [],
  disputed: ["completed", "cancelled"],
};

/** Terminal states — sessions here cannot transition further. */
export const RENTAL_SESSION_TERMINAL_STATES: readonly RentalSessionStatus[] = [
  "completed",
  "cancelled",
  "expired",
];

/**
 * Check if a transition from `from` to `to` is valid.
 */
export function isValidRentalSessionTransition(
  from: RentalSessionStatus,
  to: RentalSessionStatus
): boolean {
  const allowed = RENTAL_SESSION_TRANSITIONS[from];
  return allowed.includes(to);
}

/**
 * Check if a session status is terminal (no further transitions allowed).
 */
export function isTerminalRentalSessionStatus(status: RentalSessionStatus): boolean {
  return RENTAL_SESSION_TERMINAL_STATES.includes(status);
}

// ─── Validation ─────────────────────────────────────────────

/** Repo scope must be `owner/repo` format, no path traversal. */
const REPO_SCOPE_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

export function isValidRepoScope(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!REPO_SCOPE_PATTERN.test(trimmed)) return false;
  // Block path traversal
  if (trimmed.includes("..")) return false;
  return true;
}

/** CU budget must be within sane bounds. */
export const MIN_CU_BUDGET = 1_000;
export const MAX_CU_BUDGET = 10_000_000;

export function isValidCUBudget(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_CU_BUDGET && value <= MAX_CU_BUDGET;
}

/** Listing display name — 2-100 chars after trim. */
export function isValidListingDisplayName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.length <= 100;
}

/** Max concurrent sessions global limit — 1-10. */
export const MAX_GLOBAL_CONCURRENT_SESSIONS = 10;

export function isValidConcurrentLimit(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_GLOBAL_CONCURRENT_SESSIONS;
}

/** Session max duration limit — 15 min to 24 hours. */
export const MIN_SESSION_DURATION_MINUTES = 15;
export const MAX_SESSION_DURATION_MINUTES = 24 * 60; // 1440

export function isValidSessionDuration(minutes: number): boolean {
  return (
    Number.isInteger(minutes) &&
    minutes >= MIN_SESSION_DURATION_MINUTES &&
    minutes <= MAX_SESSION_DURATION_MINUTES
  );
}

/** Max listings per provider (rate limit). */
export const MAX_LISTINGS_PER_PROVIDER = 10;

// ─── Normalizers ────────────────────────────────────────────

function normalizeEnumValue<T extends readonly string[]>(
  value: unknown,
  allowed: T
): T[number] | null {
  const normalized = String(value || "").trim().toLowerCase();
  return allowed.includes(normalized as T[number]) ? (normalized as T[number]) : null;
}

export function normalizeRentalListingStatus(value: unknown): RentalListingStatus | null {
  return normalizeEnumValue(value, RENTAL_LISTING_STATUSES);
}

export function normalizeRentalSessionStatus(value: unknown): RentalSessionStatus | null {
  return normalizeEnumValue(value, RENTAL_SESSION_STATUSES);
}

export function normalizeRentalOutputType(value: unknown): RentalOutputType | null {
  return normalizeEnumValue(value, RENTAL_OUTPUT_TYPES);
}

export function normalizeRentalIdeLabel(value: unknown): RentalIdeLabel | null {
  return normalizeEnumValue(value, RENTAL_IDE_LABELS);
}

// ─── Request / Response Types ───────────────────────────────

export interface CreateListingRequest {
  agent_display_name: string;
  agent_model: string;
  agent_ide: string;
  agent_description?: string;
  cu_budget_total: number;
  cu_budget_per_session?: number;
  available_until?: string; // ISO timestamp
  max_concurrent_sessions: number;
  supported_output_types: RentalOutputType[];
  price_per_1k_cu: number; // must be 0 for v1
}

export interface CreateSessionRequest {
  listing_id: string;
  task_title: string;
  task_description: string;
  task_acceptance_criteria?: string;
  repo_scope: string;
  target_branch: string;
  expected_outcome: RentalOutputType;
  max_duration_minutes?: number;
}

export interface HeartbeatRequest {
  tokens_input: number;
  tokens_output: number;
  status: "working" | "idle" | "blocked";
}

export interface HeartbeatResponse {
  ok: boolean;
  cu_used_this_heartbeat: number;
  cu_used_total: number;
  cu_remaining: number;
  budget_warning: boolean;
  budget_exhausted: boolean;
}

// ─── Listing Validation ─────────────────────────────────────

export interface ListingValidationError {
  field: string;
  message: string;
}

/**
 * Validate a CreateListingRequest. Returns an array of errors (empty = valid).
 */
export function validateCreateListing(
  req: CreateListingRequest,
  knownModels: readonly string[]
): ListingValidationError[] {
  const errors: ListingValidationError[] = [];

  if (!isValidListingDisplayName(req.agent_display_name)) {
    errors.push({ field: "agent_display_name", message: "Must be 2-100 characters" });
  }

  if (!knownModels.includes(req.agent_model)) {
    errors.push({ field: "agent_model", message: `Unknown model: ${req.agent_model}` });
  }

  if (!normalizeRentalIdeLabel(req.agent_ide)) {
    errors.push({ field: "agent_ide", message: `Unknown IDE: ${req.agent_ide}` });
  }

  if (!isValidCUBudget(req.cu_budget_total)) {
    errors.push({
      field: "cu_budget_total",
      message: `Must be integer between ${MIN_CU_BUDGET} and ${MAX_CU_BUDGET}`,
    });
  }

  if (
    req.cu_budget_per_session !== undefined &&
    req.cu_budget_per_session !== null &&
    (!Number.isInteger(req.cu_budget_per_session) ||
      req.cu_budget_per_session < MIN_CU_BUDGET ||
      req.cu_budget_per_session > req.cu_budget_total)
  ) {
    errors.push({
      field: "cu_budget_per_session",
      message: "Must be integer, ≥ 1000, and ≤ cu_budget_total",
    });
  }

  if (!isValidConcurrentLimit(req.max_concurrent_sessions)) {
    errors.push({
      field: "max_concurrent_sessions",
      message: `Must be 1-${MAX_GLOBAL_CONCURRENT_SESSIONS}`,
    });
  }

  if (!Array.isArray(req.supported_output_types) || req.supported_output_types.length === 0) {
    errors.push({
      field: "supported_output_types",
      message: "Must include at least one output type",
    });
  } else {
    for (const ot of req.supported_output_types) {
      if (!normalizeRentalOutputType(ot)) {
        errors.push({
          field: "supported_output_types",
          message: `Unknown output type: ${ot}`,
        });
      }
    }
  }

  // v1: price must be 0 (free only)
  if (req.price_per_1k_cu !== 0) {
    errors.push({
      field: "price_per_1k_cu",
      message: "Paid rentals are not supported in v1. Must be 0.",
    });
  }

  return errors;
}

// ─── Session Validation ─────────────────────────────────────

/**
 * Validate a CreateSessionRequest. Returns an array of errors (empty = valid).
 */
export function validateCreateSession(
  req: CreateSessionRequest
): ListingValidationError[] {
  const errors: ListingValidationError[] = [];

  if (!req.listing_id || !req.listing_id.trim()) {
    errors.push({ field: "listing_id", message: "Required" });
  }

  if (!req.task_title || req.task_title.trim().length < 2) {
    errors.push({ field: "task_title", message: "Must be at least 2 characters" });
  }

  if (!req.task_description || req.task_description.trim().length < 10) {
    errors.push({ field: "task_description", message: "Must be at least 10 characters" });
  }

  if (!req.repo_scope || !isValidRepoScope(req.repo_scope)) {
    errors.push({ field: "repo_scope", message: "Must be owner/repo format" });
  }

  if (!req.target_branch || !req.target_branch.trim()) {
    errors.push({ field: "target_branch", message: "Required" });
  }

  if (!normalizeRentalOutputType(req.expected_outcome)) {
    errors.push({ field: "expected_outcome", message: "Must be research_note, comment, or draft_pr" });
  }

  if (req.max_duration_minutes !== undefined && !isValidSessionDuration(req.max_duration_minutes)) {
    errors.push({
      field: "max_duration_minutes",
      message: `Must be ${MIN_SESSION_DURATION_MINUTES}-${MAX_SESSION_DURATION_MINUTES}`,
    });
  }

  return errors;
}

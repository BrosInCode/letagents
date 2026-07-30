/**
 * Add Agent supervised launch event contract (task_84).
 *
 * MACHINE GRAMMAR: every event is a past-tense *completed fact*
 * (`subject.completed_fact`), never an intention. `provider.started` is
 * evidence; "Starting…" is a UI state the renderer derives from the last
 * completed fact. Keeping the API in completed facts is what lets the renderer
 * show exactly one in-progress step without the API inventing progress.
 *
 * ORDERING & DELIVERY: events carry a per-launch monotonically increasing
 * `sequence`. Delivery is at-least-once, so consumers MUST fold idempotently by
 * `(launchId, sequence)` — a duplicate or reordered event never advances the
 * journey twice and never regresses it.
 *
 * SOURCE OF TRUTH: Electron owns the pre-durable connection facts, because an
 * unreachable background service cannot report its own unreachability. The
 * daemon owns durable lifecycle facts once the claim is persisted. In this
 * build the post-durable facts are still *derived by the renderer* from the
 * manifest snapshot it already polls (see supervised-launch.ts), so the
 * post-durable event types below are reserved for the follow-up durable journal
 * and are not emitted yet. `durable` records whether a fact is persisted by the
 * daemon (true) or a transient desktop observation (false) — the UI must never
 * pretend an event is durable before it is persisted.
 */

/** Ordered launch lifecycle vocabulary. Pre-durable facts are emitted today;
 * post-durable facts are reserved for the durable daemon journal follow-up. */
export type DesktopLaunchEventType =
  // Pre-durable, Electron-owned (emitted today):
  | "launch.requested"
  | "supervisor.connected"
  | "agent.saved"
  | "launch.activated"
  // Post-durable, daemon-owned (reserved; derived from the manifest today):
  | "workspace.prepared"
  | "provider.started"
  | "room.connected"
  | "identity.registered"
  | "agent.ready"
  // Terminal, either source:
  | "launch.blocked"
  | "launch.failed"
  | "launch.cancelled";

/**
 * Product recovery-action codes. The renderer maps each to a single primary
 * action button in plain language; raw daemon/worktree/session terms stay in
 * diagnostics and never reach this contract.
 */
export type DesktopLaunchRecoveryAction =
  | "retry"
  | "reconnect"
  | "sign_in"
  | "choose_project";

export interface DesktopLaunchEvent {
  /** Stable launch id; equals the supervised entry's `creationRequestId`. */
  launchId: string;
  /** Supervised manifest entry id once the durable claim exists; null before. */
  entryId: string | null;
  roomIdentifier: string;
  provider: string;
  /** Per-launch monotonic sequence. Consumers fold idempotently by this. */
  sequence: number;
  type: DesktopLaunchEventType;
  /** ISO-8601 timestamp of when the fact completed. */
  at: string;
  /** Safe structured diagnostic detail; never secrets, never raw error dumps. */
  detail: string | null;
  /**
   * Credential-redacted technical cause for terminal facts, shown only under
   * progressive disclosure. May contain paths and error jargon; never secrets.
   */
  diagnostic?: string | null;
  /** Recovery affordance for blocked/failed/cancelled facts; null otherwise. */
  recovery: DesktopLaunchRecoveryAction | null;
  /** True when the fact is persisted by the daemon; false for transient desktop observations. */
  durable: boolean;
}

/** A terminal launch fact ends the pre-durable window with a failure/cancel. */
export const DESKTOP_LAUNCH_TERMINAL_EVENT_TYPES: readonly DesktopLaunchEventType[] = [
  "launch.blocked",
  "launch.failed",
  "launch.cancelled",
];

export function isDesktopLaunchTerminalEventType(type: DesktopLaunchEventType): boolean {
  return DESKTOP_LAUNCH_TERMINAL_EVENT_TYPES.includes(type);
}

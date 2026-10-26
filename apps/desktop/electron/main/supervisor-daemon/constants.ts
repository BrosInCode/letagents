export const SUPERVISOR_DAEMON_PROTOCOL_VERSION = 3;
// Keep in sync with daemon/types.ts. Protocol compatibility permits a clean
// handoff; implementation equality decides whether the already-running daemon
// actually contains this desktop build's fixes.
export const SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION = "2.0.272";
/**
 * The room-level state channel carries activity summaries, not history. Keep in
 * sync with STATE_WATCH_ACTIVITY_SUMMARY_LIMIT in daemon/state-watch-projection.ts;
 * enforcing it here as well keeps the renderer payload bounded even if a daemon
 * ever answers with more than it promised.
 */
export const SUPERVISOR_STATE_ACTIVITY_SUMMARY_LIMIT = 16;
export const REQUEST_TIMEOUT_MS = 3_000;
export const MANIFEST_LIST_REQUEST_TIMEOUT_MS = 15_000;
// Once configuration application is admitted, the daemon may already be
// stopping the current provider. Abandoning that authority-bearing request
// would make a successful replacement look retryable to the renderer.
export const CONFIGURATION_APPLY_REQUEST_TIMEOUT_MS = 0;
// Retirement can queue behind one already-admitted worker mint (3 x 10s) so
// its background completion channel needs a deadline that covers that safety
// fence. The renderer no longer waits on this request.
export const RETIRE_REQUEST_TIMEOUT_MS = 60_000;
// Room-ingress bootstrap is an authority-bearing admission that mints a
// worker session and reads the initial room tail against the cloud. Each of
// those daemon-side requests is bounded at 20s, so the client deadline must
// cover both plus overhead — the tight control-request timeout aborted real
// launches on slow networks and orphaned their durable claims as paused.
export const BOOTSTRAP_INGRESS_REQUEST_TIMEOUT_MS = 45_000;
// Host-grant installation attaches to the live provider (up to ~32s of
// bounded probes) and mints a worker session (3 cloud attempts x 10s) inside
// the entry lock; the tight control timeout aborted real launches while the
// daemon was still doing legitimate bounded work.
export const INSTALL_HOST_GRANT_REQUEST_TIMEOUT_MS = 60_000;
// Runtime recovery attaches to the provider and drains delivery; conversation
// restoration probes provider continuations at 0/1/3/7s offsets. Both exceed
// the 3s control budget by design.
export const RECOVERY_REQUEST_TIMEOUT_MS = 30_000;
// Once prepare_handoff is admitted, the daemon is fenced and must durably
// drain every already-running tool before replacement. A client deadline here
// would abandon a healthy long operation halfway through that protocol.
export const HANDOFF_DRAIN_REQUEST_TIMEOUT_MS = 0;
export const TURN_CONTROL_REQUEST_TIMEOUT_MS = 15_000;
// Database readiness precedes interrupted-work and workspace recovery. That
// recovery must finish before the socket opens, and can exceed eight seconds.
// Updates join this wait before handing off the same child, so allow a bounded
// recovery window without treating a slow daemon as absent or spawning another.
export const START_TIMEOUT_MS = 60_000;
export const NATURAL_EXIT_TIMEOUT_MS = 2_000;
export const TERMINATE_EXIT_TIMEOUT_MS = 2_000;
export const KILL_EXIT_TIMEOUT_MS = 1_000;
export const PROCESS_POLL_INTERVAL_MS = 25;

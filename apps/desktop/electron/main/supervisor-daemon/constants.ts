import {
  DAEMON_IMPLEMENTATION_VERSION,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RPC_TIMEOUTS,
  DAEMON_STATE_ACTIVITY_SUMMARY_LIMIT,
} from "#daemon-contract/index.js";

// Protocol version, implementation version, state summary limit, and RPC
// timeouts all derive from the single shared contract (#daemon-contract/index.js).
export const SUPERVISOR_DAEMON_PROTOCOL_VERSION = DAEMON_PROTOCOL_VERSION;
export const SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION = DAEMON_IMPLEMENTATION_VERSION;
export const SUPERVISOR_STATE_ACTIVITY_SUMMARY_LIMIT = DAEMON_STATE_ACTIVITY_SUMMARY_LIMIT;

export const REQUEST_TIMEOUT_MS = DAEMON_RPC_TIMEOUTS.defaultMs;
export const MANIFEST_LIST_REQUEST_TIMEOUT_MS = DAEMON_RPC_TIMEOUTS.richReadMs;
export const HANDOFF_DRAIN_REQUEST_TIMEOUT_MS = DAEMON_RPC_TIMEOUTS.noneMs;
export const TURN_CONTROL_REQUEST_TIMEOUT_MS = DAEMON_RPC_TIMEOUTS.turnControlMs;

// Electron-local daemon process lifecycle timings (not wire RPC timeouts).
// Database readiness precedes interrupted-work and workspace recovery. That
// recovery must finish before the socket opens, and can exceed eight seconds.
// Updates join this wait before handing off the same child, so allow a bounded
// recovery window without treating a slow daemon as absent or spawning another.
export const START_TIMEOUT_MS = 60_000;
export const NATURAL_EXIT_TIMEOUT_MS = 2_000;
export const TERMINATE_EXIT_TIMEOUT_MS = 2_000;
export const KILL_EXIT_TIMEOUT_MS = 1_000;
export const PROCESS_POLL_INTERVAL_MS = 25;

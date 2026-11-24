/**
 * Single source of truth for daemon control-socket protocol version,
 * implementation version, framing bounds, and RPC timeouts.
 *
 * Both the daemon (`apps/desktop/daemon`) and the Electron client
 * (`apps/desktop/electron/main/supervisor-daemon`) derive from this file.
 * Do not duplicate these constants elsewhere.
 */

export const DAEMON_PROTOCOL_VERSION: number = 3;

// Protocol compatibility permits a clean handoff; implementation equality
// decides whether the already-running daemon contains this desktop build's
// code. Every PR that changes daemon or provider-runtime code takes a new
// value so an updated desktop replaces a running older daemon.
export const DAEMON_IMPLEMENTATION_VERSION: string = "2.0.284-modern.30";

/**
 * Maximum number of recent activity events carried in state-watch summaries
 * and `manifest.list` summary projections. Enforced on both daemon and client.
 */
export const DAEMON_STATE_ACTIVITY_SUMMARY_LIMIT = 16 as const;

/** Maximum frame bytes for standard control socket requests (64 KiB). */
export const DAEMON_CONTROL_MAX_REQUEST_BYTES = 64 * 1024;

/** Maximum frame bytes for `local_board.mutate` requests and socket buffers (16 MiB). */
export const DAEMON_LOCAL_BOARD_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Canonical RPC client timeouts (in milliseconds). `0` denotes an unlimited
 * wait (`{ kind: "none" }` in the language-neutral schema) for authority-bearing
 * operations that must not be abandoned mid-protocol.
 */
export const DAEMON_RPC_TIMEOUTS = Object.freeze({
  defaultMs: 3_000,
  richReadMs: 15_000,
  turnControlMs: 15_000,
  roomMoveCommitMs: 15_000,
  localBoardMs: 30_000,
  longPollDefaultWaitMs: 25_000,
  longPollMaxWaitMs: 30_000,
  noneMs: 0,
} as const);

/**
 * Canonical client-side observation wait budgets (in milliseconds) for async
 * RPC effects after the control socket returns `{ effect_id, daemon_generation }`
 * within `DAEMON_RPC_TIMEOUTS.defaultMs`. `0` means no caller deadline
 * (e.g. `supervisor.apply_agent_configuration`, which legitimately waits for
 * an active turn to finish before replacing a provider).
 */
export const DAEMON_ASYNC_RPC_WAIT_TIMEOUTS = Object.freeze({
  recoverAgentRuntimeMs: 30_000,
  bootstrapRoomIngressMs: 45_000,
  installHostGrantMs: 60_000,
  retireAgentMs: 60_000,
  applyAgentConfigurationMs: 0,
} as const);

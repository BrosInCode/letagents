/**
 * Shared gate for the desktop renderer's periodic pollers (room metadata tick,
 * sidebar refresh, managed-agent sessions poll, agent-detail modal poll).
 *
 * A background window should do no polling work. Chromium keeps hidden-window
 * timers ticking (throttled to ~1s), but the interval bodies here each fan out
 * real IPC/HTTP, so every tick early-returns while the document is hidden rather
 * than starting/stopping the interval — that start/stop choreography breeds
 * lifecycle bugs. SSE keeps running while hidden, so event-fed data stays
 * current; only the poll-only catch-up is deferred until the window is visible
 * again.
 *
 * `inFlight` lets a caller additionally skip a tick whose previous run has not
 * settled, so a slow backend cannot stack overlapping request bursts.
 */
export function shouldSkipPollTick(input: { hidden: boolean; inFlight?: boolean }): boolean {
  return input.hidden || input.inFlight === true;
}

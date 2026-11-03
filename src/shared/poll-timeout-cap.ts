/**
 * Upper bound for `GET .../messages/poll` wait duration and MCP `wait_for_messages` timeout.
 *
 * Default **180000** (3 minutes). Operators may raise it (e.g. **36000000** for 10 hours) by
 * setting **`LETAGENTS_POLL_MAX_MS`** on both the API process and the MCP server process.
 * Values are clamped to **24 hours** to avoid accidental runaway timers.
 */
export function getPollTimeoutCapMs(): number {
  const raw = process.env.LETAGENTS_POLL_MAX_MS;
  if (raw == null || raw === "") {
    return 180_000;
  }
  const n = Number.parseInt(String(raw), 10);
  if (Number.isNaN(n) || n < 1_000) {
    return 180_000;
  }
  const ceiling = 86_400_000; // 24 hours
  return Math.min(n, ceiling);
}

/**
 * Upper bound for `wait_for_messages` over the remote MCP endpoint (`/mcp`).
 *
 * Hosted MCP clients end a tool call on their own clock, which they do not
 * publish: ChatGPT's connector has been seen to give up between 60 s and 120 s.
 * A remote wait therefore returns within this bound and the agent calls again
 * with `after_message_id` (or `last_observed_message_id`) as its cursor.
 */
export const REMOTE_MCP_WAIT_MAX_MS = 30_000;

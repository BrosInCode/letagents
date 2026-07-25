/**
 * Message info ships as a server foundation first. The user-facing surface
 * stays gated until the supervised daemon publishes its receipt lifecycle
 * (responding/retrying/blocked/no_reply/cancelled) — showing the card before
 * then would present supervised agents as forever "not yet seen".
 *
 * Enable locally for development/verification:
 *   localStorage.setItem('letagents:message-info', '1')
 * or build with VITE_MESSAGE_INFO_ENABLED=true.
 */
export function messageInfoSurfaceEnabled(): boolean {
  try {
    if (window.localStorage?.getItem('letagents:message-info') === '1') return true
  } catch {
    // Storage unavailable (private mode); fall through to the build flag.
  }
  return import.meta.env?.VITE_MESSAGE_INFO_ENABLED === 'true'
}

/**
 * A request to join was answered somewhere in this page (the drawer's Requests
 * list, say). The banner at the top of the room drops it at once, before the
 * server's own answer arrives on the stream. No imports: the drawer must not
 * pull the sound and stream modules in with it.
 */
const listeners = new Set<(requestId: string) => void>()

export function publishJoinRequestDecided(requestId: string): void {
  for (const listener of listeners) listener(requestId)
}

export function onJoinRequestDecided(listener: (requestId: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

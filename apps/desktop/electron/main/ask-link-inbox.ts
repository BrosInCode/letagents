/**
 * A link that arrived before the window could take it. Kept apart from
 * ask-links.ts, which needs Electron's `app`, so the IPC handlers can read it
 * without loading Electron at import time.
 */
let pendingToken: string | null = null;
let rendererReady = false;

export function holdAskLink(token: string): void { pendingToken = token; }
export function askLinkRendererReady(): boolean { return rendererReady; }
export function clearHeldAskLink(): void { pendingToken = null; }

/** The renderer takes a link that arrived before it loaded, once. */
export function takePendingAskLink(): string | null {
  rendererReady = true;
  const token = pendingToken;
  pendingToken = null;
  return token;
}

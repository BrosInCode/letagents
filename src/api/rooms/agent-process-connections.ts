/**
 * The process connections this server holds open, by session.
 *
 * Two things reach a connection from outside its own request. A session that
 * ends here is told at once, rather than when the connection next looks. And
 * a server that is shutting down lets go of every connection without saying
 * anything about the process at the other end: it is the server that is
 * leaving, and the process will connect to whichever server comes next.
 */
export interface HeldAgentProcessConnection {
  /** The session ended: tell the process and close. */
  sessionEnded(): void;
  /** This server is leaving: close, and record nothing about the process. */
  serverLeaving(): void;
}

const held = new Map<string, Set<HeldAgentProcessConnection>>();
let leaving = false;

/** Returns the release for this connection. */
export function holdAgentProcessConnection(
  sessionId: string,
  connection: HeldAgentProcessConnection,
): () => void {
  if (leaving) {
    // Opened while the server was already letting go: let go of it too.
    connection.serverLeaving();
    return () => undefined;
  }
  const connections = held.get(sessionId) ?? new Set();
  connections.add(connection);
  held.set(sessionId, connections);
  return () => {
    connections.delete(connection);
    if (connections.size === 0 && held.get(sessionId) === connections) held.delete(sessionId);
  };
}

export function announceAgentSessionEnded(sessionId: string): void {
  for (const connection of [...held.get(sessionId) ?? []]) connection.sessionEnded();
}

export function releaseAgentProcessConnectionsForShutdown(): void {
  leaving = true;
  for (const connections of [...held.values()]) {
    for (const connection of [...connections]) connection.serverLeaving();
  }
}

/** For a server that starts again within one process, as tests do. */
export function resumeAgentProcessConnections(): void {
  leaving = false;
}

export function heldAgentProcessConnectionCount(): number {
  let count = 0;
  for (const connections of held.values()) count += connections.size;
  return count;
}

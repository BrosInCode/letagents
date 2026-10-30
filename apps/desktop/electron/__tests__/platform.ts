import { createServer, type Server, type Socket } from "node:net";

import { acceptDaemonPeer, daemonEndpoint, ensureDaemonProof, isWindowsPipePath, resolveDaemonProofPath } from "../../../../shared/daemon-endpoint.mjs";

// Windows test helpers, in one place.
//
// A test that needs something Windows lacks skips itself there with a
// one-line reason, for `test(name, { skip: reason }, fn)`. Each reason is
// defined here, so the list of what does not run on Windows stays short and
// can be read at once. False off Windows.

/**
 * The daemon endpoint under a test root: `<root>/daemon.sock` on POSIX, a
 * per-root named pipe with its proof file on Windows.
 */
export function testDaemonEndpoint(root: string): { socketPath: string; peerProofPath: string | null } {
  const endpoint = daemonEndpoint(root);
  return { socketPath: endpoint.listenPath, peerProofPath: endpoint.proofPath };
}

/**
 * A stand-in daemon server for `socketPath`. On Windows it answers the proof
 * handshake first, as every daemon pipe does; elsewhere it is net.createServer.
 */
export function createTestDaemonServer(socketPath: string, onConnection: (socket: Socket) => void): Server {
  if (!isWindowsPipePath(socketPath)) return createServer(onConnection);
  const proofPath = resolveDaemonProofPath(socketPath);
  if (!proofPath) throw new Error(`No daemon proof is known for ${socketPath}.`);
  const proof = ensureDaemonProof(proofPath);
  return createServer((socket) => { void proof.then((value) => acceptDaemonPeer(socket, value, onConnection)); });
}

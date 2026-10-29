import type { Socket } from "node:net";

export interface DaemonEndpoint {
  stateDir: string;
  transport: "unix" | "pipe";
  listenPath: string;
  connectPath: string;
  /** The client proof file; null on POSIX, where the socket file mode protects the endpoint. */
  proofPath: string | null;
}
export const DAEMON_SOCKET_FILE: string;
export const DAEMON_PROOF_FILE: string;
export const DAEMON_STATE_DIR_ENV: string;
export function isWindowsPipePath(path: unknown): boolean;
export function currentWindowsAccount(): string;
export function windowsPipeName(prefix: string, key: string, account: string): string;
export function daemonEndpoint(stateDir: string, options?: { platform?: NodeJS.Platform; account?: string }): DaemonEndpoint;
export function resolveDaemonProofPath(connectPath: string, options?: { env?: NodeJS.ProcessEnv; home?: string }): string | null;
export function ensureDaemonProof(proofPath: string, options?: import("./owner-private-fs.mjs").OwnerPrivateOptions & { recheckDelayMs?: number }): Promise<string>;
export function rememberPrivateDaemonProof(path: string, checkedInfo: import("node:fs").Stats): void;
export function prepareDaemonConnection(connectPath: string, options?: { proofPath?: string | null } & import("./owner-private-fs.mjs").OwnerPrivateOptions): void;
export function connectDaemon(connectPath: string, options?: { proofPath?: string | null; handshake?: boolean; handshakeTimeoutMs?: number } & import("./owner-private-fs.mjs").OwnerPrivateOptions): Socket;
export function acceptDaemonPeer(socket: Socket, proof: string, onAccepted: (socket: Socket) => void, options?: { timeoutMs?: number }): void;

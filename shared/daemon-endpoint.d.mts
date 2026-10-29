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
export function defaultDaemonStateDir(options?: { home?: string }): string;
export function isWindowsPipePath(path: unknown): boolean;
export function currentWindowsUserSid(options?: {
  env?: NodeJS.ProcessEnv;
  run?: (file: string, args: string[], options: { encoding: "utf8"; windowsHide: boolean; timeout: number }) => string | Buffer;
}): string;
export function currentWindowsAccount(): string;
export function windowsPipeName(prefix: string, key: string, account: string): string;
export function daemonEndpoint(stateDir: string, options?: { platform?: NodeJS.Platform; account?: string }): DaemonEndpoint;
export function resolveDaemonProofPath(connectPath: string, options?: { env?: NodeJS.ProcessEnv; home?: string }): string | null;
export function protectWindowsPrivateFile(path: string, options?: {
  env?: NodeJS.ProcessEnv;
  run?: (file: string, args: string[], options: { encoding: "utf8"; windowsHide: boolean; timeout: number }) => string | Buffer;
  userSid?: string;
}): void;
export function ensureDaemonProof(proofPath: string, options?: { protect?: ((path: string) => void) | null }): Promise<string>;
export function connectDaemon(connectPath: string, options?: { proofPath?: string | null; handshake?: boolean; handshakeTimeoutMs?: number }): Socket;
export function acceptDaemonPeer(socket: Socket, proof: string, onAccepted: (socket: Socket) => void, options?: { timeoutMs?: number }): void;

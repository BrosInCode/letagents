/** Paths, clock and retention settings the supervisor daemon is built with. */
import type { defaultDaemonPaths } from "../singleton.js";

export type DaemonPaths = Pick<ReturnType<typeof defaultDaemonPaths>, "lockPath" | "socketPath" | "manifestPath" | "auditPath"> & Partial<Pick<ReturnType<typeof defaultDaemonPaths>, "legacyManifestPath" | "attemptsPath" | "attemptsRoot" | "workspaceRoot" | "workerBindingsPath" | "peerProofPath">>;
export type RecoveryClock = {
  nowMs?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout; sleep?: (delayMs: number) => Promise<void>; random?: () => number;
};
/** Copies for replies that never published are removed after this long. */
export const REPLY_ATTACHMENT_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

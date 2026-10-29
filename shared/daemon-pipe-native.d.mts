export const DAEMON_PIPE_ADDON_NAME: "letagents-daemon-pipe.node";
export const DAEMON_PIPE_ADDON_ENV: "LETAGENTS_DAEMON_PIPE_ADDON";
export const DAEMON_PIPE_ADDON_ERROR: "ERR_LETAGENTS_DAEMON_PIPE_ADDON";
export interface DaemonPipeSeal {
  sourceSha256?: string;
  builds?: Partial<Record<"x64" | "arm64", { sha256: string; vcToolsVersion?: string; windowsSdkVersion?: string }>>;
}
export interface DaemonPipeAddonOptions {
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  arch?: string;
  platform?: NodeJS.Platform;
  includeLocalBuild?: boolean;
  seal?: DaemonPipeSeal | null;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => Buffer;
}
export function sealedDaemonPipeAddonSha256(arch?: string, seal?: DaemonPipeSeal | null): string | null;
export function daemonPipeAddonCandidates(options?: DaemonPipeAddonOptions): string[];
export function findDaemonPipeAddon(options?: DaemonPipeAddonOptions): { path: string; sha256: string };
export function loadDaemonPipeAddon(options?: DaemonPipeAddonOptions): {
  path: string;
  sha256: string;
  /** Open the pipe: SECURITY_IDENTIFICATION, server process checked; throws with a `code`. */
  open(name: string): { fd: number; serverPid: number };
};

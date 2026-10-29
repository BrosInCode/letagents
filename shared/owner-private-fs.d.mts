import type { BigIntStats, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export declare const PRIVATE_DIRECTORY_MODE: 0o700;
export declare const PRIVATE_FILE_MODE: 0o600;
export declare const SYSTEM_SID: "S-1-5-18";

export type PrivateKind = "file" | "directory";
type StatLike = Pick<Stats, "mode" | "uid"> | Pick<BigIntStats, "mode" | "uid">;

/** The Windows facts behind every check; a native helper may replace the default one. */
export interface WindowsSecurity {
  currentUserSid(): Promise<string>;
  currentUserSidSync(): string;
  /** One SDDL string per path, in order; null where it could not be read. */
  readSddl(paths: readonly string[]): Promise<(string | null)[]>;
  readSddlSync(paths: readonly string[]): (string | null)[];
  protect(path: string, kind: PrivateKind): Promise<void>;
  protectSync(path: string, kind: PrivateKind): void;
}
export type ToolRunner = (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => Promise<string>;
export type ToolRunnerSync = (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => string;

export interface OwnerPrivateOptions {
  /** Defaults to process.platform; tests pass "win32". */
  platform?: NodeJS.Platform;
  windowsSecurity?: WindowsSecurity;
}
export interface OwnerPrivateCheckOptions extends OwnerPrivateOptions {
  /** POSIX only: require exactly this mode (& 0o777) instead of "no group or other bits". */
  exactMode?: number;
}

/** Tests only: use this platform and WindowsSecurity wherever a call passes no options; null restores the real ones. */
export declare function overrideOwnerPrivatePlatformForTesting(value: { platform: NodeJS.Platform; windowsSecurity?: WindowsSecurity } | null): void;
/** process.platform, or the test override. Callers branch on this, not on process.platform. */
export declare function ownerPrivatePlatform(options?: OwnerPrivateOptions): NodeJS.Platform;
export declare function windowsSystemTool(name: string, env?: NodeJS.ProcessEnv): string;
export declare function windowsToolPaths(env?: NodeJS.ProcessEnv): { whoami: string; icacls: string; powershell: string };
export declare function parseWhoamiUserSid(output: string): string;
export declare function parseSddlLines(output: string, count: number): (string | null)[];
export declare function icaclsProtectArguments(path: string, kind: PrivateKind, sid: string): string[];
export declare function createWindowsSecurity(options?: { run?: ToolRunner; runSync?: ToolRunnerSync; env?: NodeJS.ProcessEnv }): WindowsSecurity;

export interface ParsedSddl {
  owner: string;
  dacl: { flags: string; aces: { type: string; flags: string; rights: string; sid: string }[] } | null;
}
export declare function parseSddl(sddl: string | null | undefined): ParsedSddl | null;
export declare function sddlIsOwnedBy(sddl: string | null | undefined, sid: string): boolean;
export declare function sddlIsOwnerPrivate(sddl: string | null | undefined, sid: string): boolean;

export declare function isOwnedByCurrentUser(path: string, info: StatLike, options?: OwnerPrivateOptions): Promise<boolean>;
export declare function isOwnedByCurrentUserSync(path: string, info: StatLike, options?: OwnerPrivateOptions): boolean;
export declare function everyOwnedByCurrentUserSync(entries: readonly { path: string; info: StatLike }[], options?: OwnerPrivateOptions): boolean;
export declare function isOwnerPrivate(path: string, info: StatLike, options?: OwnerPrivateCheckOptions): Promise<boolean>;
export declare function isOwnerPrivateSync(path: string, info: StatLike, options?: OwnerPrivateCheckOptions): boolean;
export declare function assertOwnerPrivate(path: string, options?: OwnerPrivateCheckOptions & { kind?: PrivateKind }): Promise<Stats>;
export declare function assertOwnerPrivateSync(path: string, options?: OwnerPrivateCheckOptions & { kind?: PrivateKind }): Stats;

export declare function protectOwnerPrivate(path: string, kind: PrivateKind, options?: OwnerPrivateOptions): Promise<void>;
export declare function protectOwnerPrivateSync(path: string, kind: PrivateKind, options?: OwnerPrivateOptions): void;
export declare function createPrivateDir(path: string, mkdirOptions?: { recursive?: boolean }, options?: OwnerPrivateOptions): Promise<string | undefined>;
export declare function createPrivateDirSync(path: string, mkdirOptions?: { recursive?: boolean }, options?: OwnerPrivateOptions): string | undefined;
export declare function syncDirectory(path: string, options?: OwnerPrivateOptions): Promise<void>;
export declare function syncDirectorySync(path: string, options?: OwnerPrivateOptions): void;
export declare function openNoFollow(path: string, flags: number, mode?: number, options?: OwnerPrivateOptions): Promise<FileHandle>;
export declare function openNoFollowSync(path: string, flags: number, mode?: number, options?: OwnerPrivateOptions): number;
export declare function writePrivateFileAtomically(path: string, data: string | Uint8Array, options?: OwnerPrivateOptions & { syncDirectory?: boolean }): Promise<void>;
export declare function writePrivateFileAtomicallySync(path: string, data: string | Uint8Array, options?: OwnerPrivateOptions & { syncDirectory?: boolean }): void;
/** `/dev/null`, or `\\.\nul` on Windows (as os.devNull there). */
export declare function nullDevice(options?: OwnerPrivateOptions): string;

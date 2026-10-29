import type { BigIntStats, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export declare const PRIVATE_DIRECTORY_MODE: 0o700;
export declare const PRIVATE_FILE_MODE: 0o600;
export declare const SYSTEM_SID: "S-1-5-18";

export type PrivateKind = "file" | "directory";
type StatLike = (Pick<Stats, "mode" | "uid"> & Partial<Pick<Stats, "dev" | "ino">>) | Pick<BigIntStats, "mode" | "uid" | "dev" | "ino">;

/** The Windows facts behind every check; a native helper may replace the default one. */
export interface WindowsSecurity {
  currentUserSid(): Promise<string>;
  currentUserSidSync(): string;
  /** One SDDL string per path, in order; null where it could not be read. */
  readSddl(paths: readonly string[]): Promise<(string | null)[]>;
  readSddlSync(paths: readonly string[]): (string | null)[];
  /** SDDL aliases that also name the current user ("LA" for this machine's built-in Administrator). */
  currentUserAliases?(): Promise<string[]>;
  currentUserAliasesSync?(): string[];
  protect(path: string, kind: PrivateKind): Promise<void>;
  protectSync(path: string, kind: PrivateKind): void;
  /** Remove every allow entry for these SIDs (the default backend has it; a fake may leave it out). */
  removeGrants?(path: string, sids: readonly string[]): Promise<void>;
  removeGrantsSync?(path: string, sids: readonly string[]): void;
  /** Start the synchronous reader now, without waiting (the default backend has it). */
  prepare?(): void;
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
  /** Windows only: always read the object's own DACL, even when this process knows it (high-value secrets). */
  checkObject?: boolean;
}

/** Tests only: use this platform and WindowsSecurity wherever a call passes no options; null restores the real ones. */
export declare function overrideOwnerPrivatePlatformForTesting(value: { platform: NodeJS.Platform; windowsSecurity?: WindowsSecurity } | null): void;
/** process.platform, or the test override. Callers branch on this, not on process.platform. */
export declare function ownerPrivatePlatform(options?: OwnerPrivateOptions): NodeJS.Platform;
export declare function windowsSystemTool(name: string, env?: NodeJS.ProcessEnv): string;
export declare function windowsToolPaths(env?: NodeJS.ProcessEnv): { whoami: string; icacls: string; powershell: string };
export declare function parseWhoamiUserSid(output: string): string;
export declare function parseWhoamiUser(output: string): { sid: string; domain: string | null };
export declare function userSidAliases(user: { sid: string; domain: string | null }, computerName: string | undefined): string[];
/** A SID string, or the SID with the SDDL aliases that also name it. */
export type UserIdentity = string | { sid: string; aliases?: readonly string[] };
/** The environment value that carries paths to the PowerShell read: one per line. */
export declare function encodeSddlPaths(paths: readonly string[]): string;
export declare function parseSddlLines(output: string, count: number): (string | null)[];
export declare function icaclsRemoveArguments(path: string, sids: readonly string[]): string[];
/**
 * After this process made `path` exclusively (open "wx", mkdir): POSIX no-op;
 * Windows marks it known when its folder is verified, else protects it.
 */
export declare function privateEntryCreated(path: string, kind: PrivateKind, options?: OwnerPrivateOptions): Promise<void>;
export declare function privateEntryCreatedSync(path: string, kind: PrivateKind, options?: OwnerPrivateOptions): void;
/** Forget every folder verified private in this process (tests that change a DACL behind the cache's back). */
export declare function forgetOwnerPrivateCache(): void;
export declare function icaclsSetOwnerArguments(path: string, sid: string): string[];
export declare const INHERITED_GROUP_SIDS: readonly string[];
export declare function icaclsProtectArguments(path: string, kind: PrivateKind, sid: string): string[];
export interface SddlServer { readonly usable: boolean; read(paths: readonly string[]): Promise<(string | null)[]>; stop(): void }
/** One long-lived PowerShell reader for asynchronous reads; `start` returns its child process. */
export declare function createSddlServer(start: () => import("node:child_process").ChildProcess): SddlServer;
export type SyncSddlReaderStart = (channel: { port: import("node:worker_threads").MessagePort; signal: SharedArrayBuffer; timeoutMs: number }) => import("node:worker_threads").Worker;
/** The worker that owns a synchronous reader: `command args` speaks the long-lived reader's line protocol. */
export declare function syncSddlReaderWorker(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): SyncSddlReaderStart;
export interface SyncSddlServer { readonly usable: boolean; prepare(): void; read(paths: readonly string[]): (string | null)[]; stop(): void }
/** One long-lived reader for synchronous reads: the caller waits (Atomics.wait) for its worker's answer. */
export declare function createSyncSddlServer(start: SyncSddlReaderStart, options?: { timeoutMs?: number }): SyncSddlServer;
export declare function createWindowsSecurity(options?: {
  run?: ToolRunner; runSync?: ToolRunnerSync; env?: NodeJS.ProcessEnv;
  /** The long-lived reader's child process; null for none. Default: PowerShell, only with the real runners. */
  startServer?: (() => import("node:child_process").ChildProcess) | null;
  /** The synchronous reader's worker; null for none. Default: PowerShell, only with the real runners. */
  startSyncServer?: SyncSddlReaderStart | null;
}): WindowsSecurity;

export interface ParsedSddl {
  owner: string;
  dacl: { flags: string; aces: { type: string; flags: string; rights: string; sid: string }[] } | null;
}
export declare function parseSddl(sddl: string | null | undefined): ParsedSddl | null;
export declare function sddlIsOwnedBy(sddl: string | null | undefined, sid: UserIdentity): boolean;
export declare function sddlExtraGrantSids(sddl: string | null | undefined, sid: UserIdentity): string[] | null;
/** Owned by the user or Administrators; allow entries only for the user, SYSTEM and Administrators. */
export declare function sddlHasOnlyAdministratorAccess(sddl: string | null | undefined, sid: UserIdentity): boolean;
export declare function sddlHasProfileDefaultAccess(sddl: string | null | undefined, sid: UserIdentity): boolean;
/** As sddlIsOwnerPrivate, but inheritance may be on: the entries alone are private. */
export declare function sddlHasPrivateEntries(sddl: string | null | undefined, sid: UserIdentity): boolean;
/** The DACL has an allow entry for this account that files and folders inherit (OI and CI). */
export declare function sddlPassesPrivateEntriesOn(sddl: string | null | undefined, sid: UserIdentity): boolean;
export declare function sddlIsOwnerPrivate(sddl: string | null | undefined, sid: UserIdentity): boolean;

export declare function isOwnedByCurrentUser(path: string, info: StatLike, options?: OwnerPrivateOptions): Promise<boolean>;
export declare function isOwnedByCurrentUserSync(path: string, info: StatLike, options?: OwnerPrivateOptions): boolean;
export declare function everyOwnedByCurrentUserSync(entries: readonly { path: string; info: StatLike }[], options?: OwnerPrivateOptions): boolean;
export declare function everyOwnerPrivateSync(entries: readonly { path: string; info: StatLike }[], options?: OwnerPrivateCheckOptions): boolean;
export declare function isOwnerPrivate(path: string, info: StatLike, options?: OwnerPrivateCheckOptions): Promise<boolean>;
/** Windows: owned by the user, allow entries only for the user, SYSTEM and Administrators (a fresh profile folder). */
export declare function hasProfileDefaultAccess(path: string, info: StatLike, options?: OwnerPrivateCheckOptions): Promise<boolean>;
export declare function isOwnerPrivateSync(path: string, info: StatLike, options?: OwnerPrivateCheckOptions): boolean;
export declare function assertOwnerPrivate(path: string, options?: OwnerPrivateCheckOptions & { kind?: PrivateKind }): Promise<Stats>;
export declare function assertOwnerPrivateSync(path: string, options?: OwnerPrivateCheckOptions & { kind?: PrivateKind }): Stats;

export interface SecretReadOptions extends OwnerPrivateOptions {
  /** Windows: make a file private, by itself, when only this account, SYSTEM and Administrators can open it (state an older version left). */
  upgradeAdministratorsOnly?: boolean;
}
/**
 * Read a high-value secret (a token, a key). POSIX: exactly readFileSync(path, encoding).
 * Windows: read through a no-follow handle only when the file's own DACL is private to this
 * account (checked again whenever its identity, change time included, is new, and after five
 * minutes); else EOWNERPRIVATE naming the file. A missing file is ENOENT.
 */
export declare function readOwnerPrivateFileSync(path: string, encoding: BufferEncoding, options?: SecretReadOptions): string;
export declare function readOwnerPrivateFileSync(path: string, encoding?: undefined, options?: SecretReadOptions): Buffer;
export declare function readOwnerPrivateFile(path: string, encoding: BufferEncoding, options?: SecretReadOptions): Promise<string>;
export declare function readOwnerPrivateFile(path: string, encoding?: undefined, options?: SecretReadOptions): Promise<Buffer>;
/** Windows: start the synchronous permissions reader (PowerShell) now, without waiting. POSIX: nothing. */
export declare function prepareOwnerPrivateReads(options?: OwnerPrivateOptions): void;
/**
 * Windows: make LetAgents' own state folder private when only this account, SYSTEM and Administrators
 * have access to it; leave any other folder as it is. Returns whether it is private now. POSIX: false, nothing done.
 */
export declare function ensurePrivateStateFolderSync(folder: string, options?: OwnerPrivateOptions): boolean;

/** `force`: run the full Windows protect even under a verified folder (a repair after a failed check). */
export declare function protectOwnerPrivate(path: string, kind: PrivateKind, options?: OwnerPrivateOptions & { force?: boolean }): Promise<void>;
export declare function protectOwnerPrivateSync(path: string, kind: PrivateKind, options?: OwnerPrivateOptions & { force?: boolean }): void;
export declare function createPrivateDir(path: string, mkdirOptions?: { recursive?: boolean }, options?: OwnerPrivateOptions): Promise<string | undefined>;
export declare function createPrivateDirSync(path: string, mkdirOptions?: { recursive?: boolean }, options?: OwnerPrivateOptions): string | undefined;
export declare function syncDirectory(path: string, options?: OwnerPrivateOptions): Promise<void>;
export declare function syncDirectorySync(path: string, options?: OwnerPrivateOptions): void;
export declare function openNoFollow(path: string, flags: number, mode?: number, options?: OwnerPrivateOptions): Promise<FileHandle>;
export declare function openNoFollowSync(path: string, flags: number, mode?: number, options?: OwnerPrivateOptions): number;
/** Windows: a new folder beside `path`, private before anything is put in it (the caller removes it). */
export declare function createPrivateStagingFolder(path: string, options?: OwnerPrivateOptions): Promise<string>;
export declare function writePrivateFileAtomically(path: string, data: string | Uint8Array, options?: OwnerPrivateOptions & { syncDirectory?: boolean }): Promise<void>;
export declare function writePrivateFileAtomicallySync(path: string, data: string | Uint8Array, options?: OwnerPrivateOptions & { syncDirectory?: boolean }): void;
/** `/dev/null`, or `\\.\nul` on Windows (as os.devNull there). */
export declare function nullDevice(options?: OwnerPrivateOptions): string;

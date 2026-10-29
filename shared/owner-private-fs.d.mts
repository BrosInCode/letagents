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
  /** The DACL alone as SDDL ("D:..."), read right after a protect (the default backend uses icacls /save). */
  readDacl?(path: string): Promise<string>;
  readDaclSync?(path: string): string;
  /** Remove every allow entry for these SIDs (the default backend has it; a fake may leave it out). */
  removeGrants?(path: string, sids: readonly string[]): Promise<void>;
  removeGrantsSync?(path: string, sids: readonly string[]): void;
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
export declare function parseWhoamiUser(output: string): { sid: string; domain: string | null };
export declare function userSidAliases(user: { sid: string; domain: string | null }, computerName: string | undefined): string[];
/** A SID string, or the SID with the SDDL aliases that also name it. */
export type UserIdentity = string | { sid: string; aliases?: readonly string[] };
/** The environment value that carries paths to the PowerShell read: one per line. */
export declare function encodeSddlPaths(paths: readonly string[]): string;
export declare function parseSddlLines(output: string, count: number): (string | null)[];
export declare function icaclsRemoveArguments(path: string, sids: readonly string[]): string[];
export declare function icaclsSaveArguments(path: string, file: string): string[];
/** The DACL line of an `icacls /save` file (UTF-16LE or UTF-8). */
export declare function parseIcaclsSave(bytes: Uint8Array): string;
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
export declare function createWindowsSecurity(options?: { run?: ToolRunner; runSync?: ToolRunnerSync; env?: NodeJS.ProcessEnv }): WindowsSecurity;

export interface ParsedSddl {
  owner: string;
  dacl: { flags: string; aces: { type: string; flags: string; rights: string; sid: string }[] } | null;
}
export declare function parseSddl(sddl: string | null | undefined): ParsedSddl | null;
export declare function sddlIsOwnedBy(sddl: string | null | undefined, sid: UserIdentity): boolean;
export declare function sddlExtraGrantSids(sddl: string | null | undefined, sid: UserIdentity): string[] | null;
export declare function sddlHasProfileDefaultAccess(sddl: string | null | undefined, sid: UserIdentity): boolean;
/** As sddlIsOwnerPrivate, but inheritance may be on: the entries alone are private. */
export declare function sddlHasPrivateEntries(sddl: string | null | undefined, sid: UserIdentity): boolean;
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

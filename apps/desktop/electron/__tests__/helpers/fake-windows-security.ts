// A stand-in for the Windows ACL tools, so a caller's Windows branch runs on a
// macOS or Linux host. A "protected" file is remembered by its identity (dev
// and ino), so, as on NTFS, its DACL moves with a rename and is shared by a
// hard link. Everything else reads as an inherited, non-private DACL.
import { lstatSync } from "node:fs";
import {
  overrideOwnerPrivatePlatformForTesting,
  type PrivateKind,
  type WindowsSecurity,
} from "../../../../../shared/owner-private-fs.mjs";

export const FAKE_USER_SID = "S-1-5-21-1004336348-1177238915-682003330-1001";
const PRIVATE_SDDL = `O:${FAKE_USER_SID}G:${FAKE_USER_SID}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${FAKE_USER_SID})`;
const FOREIGN_SDDL = "O:S-1-5-21-1004336348-1177238915-682003330-1002D:PAI(A;;FA;;;S-1-5-21-1004336348-1177238915-682003330-1002)";
const INHERITED_SDDL = `O:${FAKE_USER_SID}G:${FAKE_USER_SID}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${FAKE_USER_SID})`;

export type FakeWindowsSecurity = {
  security: WindowsSecurity;
  /** "protect:<kind>:<path>" per icacls call, in order. */
  protects: string[];
  /** Give a path an extra entry (as `icacls /grant Everyone:R` would). */
  tamper(path: string): void;
  /** Make another account the owner (as a file that account made would be). */
  giveAway(path: string): void;
  isProtected(path: string): boolean;
};

function identity(path: string): string | null {
  try {
    const info = lstatSync(path, { bigint: true });
    return `${info.dev}:${info.ino}`;
  } catch { return null; }
}

export function fakeWindowsSecurity(): FakeWindowsSecurity {
  const protectedFiles = new Set<string>();
  const foreignFiles = new Set<string>();
  const protects: string[] = [];
  const sddl = (path: string) => {
    const id = identity(path);
    if (!id) return null;
    if (foreignFiles.has(id)) return FOREIGN_SDDL;
    return protectedFiles.has(id) ? PRIVATE_SDDL : INHERITED_SDDL;
  };
  const protect = (path: string, kind: PrivateKind) => {
    const id = identity(path);
    if (!id) throw Object.assign(new Error(`icacls: ${path}: The system cannot find the file specified.`), { code: "ENOENT" });
    protects.push(`protect:${kind}:${path}`);
    // icacls cannot take another account's file from a standard user: it stays theirs.
    if (!foreignFiles.has(id)) protectedFiles.add(id);
  };
  const security: WindowsSecurity = {
    async currentUserSid() { return FAKE_USER_SID; },
    currentUserSidSync() { return FAKE_USER_SID; },
    async readSddl(paths) { return paths.map(sddl); },
    readSddlSync(paths) { return paths.map(sddl); },
    async protect(path, kind) { protect(path, kind); },
    protectSync(path, kind) { protect(path, kind); },
  };
  return {
    security,
    protects,
    tamper(path) { const id = identity(path); if (id) protectedFiles.delete(id); },
    giveAway(path) { const id = identity(path); if (id) { protectedFiles.delete(id); foreignFiles.add(id); } },
    isProtected(path) { const id = identity(path); return Boolean(id && protectedFiles.has(id)); },
  };
}

/** Run `operation` as if on Windows, with this fake in place of the ACL tools. */
export async function asWindows<T>(fake: FakeWindowsSecurity, operation: () => Promise<T> | T): Promise<T> {
  overrideOwnerPrivatePlatformForTesting({ platform: "win32", windowsSecurity: fake.security });
  try { return await operation(); } finally { overrideOwnerPrivatePlatformForTesting(null); }
}

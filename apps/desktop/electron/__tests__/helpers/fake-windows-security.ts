// A stand-in for the Windows ACL tools, so a caller's Windows branch runs on a
// macOS or Linux host. A "protected" file is remembered by its identity (dev
// and ino), so, as on NTFS, its DACL moves with a rename and is shared by a
// hard link. Everything else reads as an inherited, non-private DACL.
// Linux reuses an inode at once after a delete, so a test must not delete and
// recreate a path it has marked (tamper, giveAway, share) and expect a fresh file.
import { lstatSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  forgetOwnerPrivateCache,
  overrideOwnerPrivatePlatformForTesting,
  sddlHasOnlyAdministratorAccess,
  type PrivateKind,
  type WindowsSecurity,
} from "../../../../../shared/owner-private-fs.mjs";

export const FAKE_USER_SID = "S-1-5-21-1004336348-1177238915-682003330-1001";
const PRIVATE_SDDL = `O:${FAKE_USER_SID}G:${FAKE_USER_SID}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${FAKE_USER_SID})`;
const FOREIGN_SDDL = "O:S-1-5-21-1004336348-1177238915-682003330-1002D:PAI(A;;FA;;;S-1-5-21-1004336348-1177238915-682003330-1002)";
const SHARED_SDDL = `O:${"S-1-5-21-1004336348-1177238915-682003330-1001"}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;S-1-5-21-1004336348-1177238915-682003330-1001)(A;ID;0x1301bf;;;BU)`;
const INHERITED_PRIVATE_SDDL = `O:${FAKE_USER_SID}G:${FAKE_USER_SID}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;${FAKE_USER_SID})`;
const INHERITED_SDDL = `O:${FAKE_USER_SID}G:${FAKE_USER_SID}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${FAKE_USER_SID})`;

export type FakeWindowsSecurity = {
  security: WindowsSecurity;
  /** "protect:<kind>:<path>" per icacls call, and "upgrade:<path>" per handle upgrade, in order. */
  protects: string[];
  /** Give a path an extra Users entry (as `icacls /grant Users:R` would); what it holds inherits that. */
  tamper(path: string): void;
  /** Drop a path's own protected DACL; it inherits from the folder above again. */
  unprotect(path: string): void;
  /** Make another account the owner (as a file that account made would be). */
  giveAway(path: string): void;
  /** Give the Users group modify access (a folder another account could have changed). */
  share(path: string): void;
  /** Private: a protected private DACL of its own, or private entries inherited from a protected folder. */
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
  const sharedFiles = new Set<string>();
  const protects: string[] = [];
  const sddl = (path: string) => {
    const id = identity(path);
    if (!id) return null;
    if (foreignFiles.has(id)) return FOREIGN_SDDL;
    if (sharedFiles.has(id)) return SHARED_SDDL;
    if (protectedFiles.has(id)) return PRIVATE_SDDL;
    // As NTFS: an unprotected entry inherits from the nearest folder above it.
    for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
      const above = identity(parent);
      if (!above || foreignFiles.has(above) || sharedFiles.has(above)) return INHERITED_SDDL;
      if (protectedFiles.has(above)) return INHERITED_PRIVATE_SDDL;
    }
    return INHERITED_SDDL;
  };
  const protect = (path: string, kind: PrivateKind) => {
    const id = identity(path);
    if (!id) throw Object.assign(new Error(`icacls: ${path}: The system cannot find the file specified.`), { code: "ENOENT" });
    protects.push(`protect:${kind}:${path}`);
    // icacls cannot take another account's file from a standard user: it stays theirs.
    if (!foreignFiles.has(id)) { protectedFiles.add(id); sharedFiles.delete(id); }
  };
  // As the reader's "object:" request: the SDDL and the bytes of what the path names now.
  const readObject = (path: string) => {
    const answer = sddl(path);
    if (!answer) return null;
    try { return { sddl: answer, data: readFileSync(path) }; } catch { return null; }
  };
  // As "upgrade:": a file only this account, SYSTEM and Administrators can open becomes private.
  const upgrade = (path: string) => {
    const id = identity(path);
    if (!id || !sddlHasOnlyAdministratorAccess(sddl(path), FAKE_USER_SID)) return null;
    protects.push(`upgrade:${path}`);
    protectedFiles.add(id);
    return PRIVATE_SDDL;
  };
  const security: WindowsSecurity = {
    async currentUserSid() { return FAKE_USER_SID; },
    currentUserSidSync() { return FAKE_USER_SID; },
    async readSddl(paths) { return paths.map(sddl); },
    readSddlSync(paths) { return paths.map(sddl); },
    async readObjects(paths) { return paths.map(readObject); },
    readObjectsSync(paths) { return paths.map(readObject); },
    async upgradeObject(path) { return upgrade(path); },
    upgradeObjectSync(path) { return upgrade(path); },
    async protect(path, kind) { protect(path, kind); },
    protectSync(path, kind) { protect(path, kind); },
  };
  return {
    security,
    protects,
    // A DACL changed behind the helper's back: its verified folders are forgotten too.
    tamper(path) { const id = identity(path); if (id) { protectedFiles.delete(id); sharedFiles.add(id); } forgetOwnerPrivateCache(); },
    unprotect(path) { const id = identity(path); if (id) protectedFiles.delete(id); forgetOwnerPrivateCache(); },
    share(path) { const id = identity(path); if (id) { protectedFiles.delete(id); sharedFiles.add(id); } forgetOwnerPrivateCache(); },
    giveAway(path) { const id = identity(path); if (id) { protectedFiles.delete(id); foreignFiles.add(id); } forgetOwnerPrivateCache(); },
    isProtected(path) { const answer = sddl(path); return answer === PRIVATE_SDDL || answer === INHERITED_PRIVATE_SDDL; },
  };
}

/** Run `operation` as if on Windows, with this fake in place of the ACL tools. */
export async function asWindows<T>(fake: FakeWindowsSecurity, operation: () => Promise<T> | T): Promise<T> {
  overrideOwnerPrivatePlatformForTesting({ platform: "win32", windowsSecurity: fake.security });
  try { return await operation(); } finally { overrideOwnerPrivatePlatformForTesting(null); }
}

import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { constants, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  assertOwnerPrivate,
  assertOwnerPrivateSync,
  createPrivateDir,
  createPrivateDirSync,
  createSddlServer,
  createSyncSddlServer,
  createWindowsSecurity,
  encodeSddlPaths,
  ensurePrivateStateFolderSync,
  everyOwnedByCurrentUserSync,
  everyOwnerPrivateSync,
  forgetOwnerPrivateCache,
  icaclsProtectArguments,
  icaclsRemoveArguments,
  INHERITED_GROUP_SIDS,
  isOwnedByCurrentUser,
  isOwnerPrivate,
  isOwnerPrivateSync,
  nullDevice,
  openNoFollow,
  openNoFollowSync,
  parseSddl,
  parseSddlLines,
  parseWhoamiUser,
  privateEntryCreated,
  parseWhoamiUserSid,
  protectOwnerPrivate,
  protectOwnerPrivateSync,
  readOwnerPrivateFile,
  readOwnerPrivateFileSync,
  sddlExtraGrantSids,
  sddlHasOnlyAdministratorAccess,
  sddlHasProfileDefaultAccess,
  sddlPassesPrivateEntriesOn,
  sddlHasPrivateEntries,
  sddlIsOwnerPrivate,
  userSidAliases,
  syncDirectory,
  syncSddlReaderWorker,
  windowsSystemTool,
  windowsToolPaths,
  writePrivateFileAtomically,
  writePrivateFileAtomicallySync,
  type WindowsSecurity,
} from "../../../shared/owner-private-fs.mjs";
import { RENAME_RETRY_DELAYS_MS, renameWithRetryAsync } from "../../../shared/rename-retry.mjs";

const USER = "S-1-5-21-1004336348-1177238915-682003330-1001";
const OTHER = "S-1-5-21-1004336348-1177238915-682003330-1002";
const PRIVATE_FILE = `O:${USER}G:${USER}D:P(A;;FA;;;SY)(A;;FA;;;${USER})`;
const PRIVATE_FOLDER = `O:${USER}G:${USER}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})`;
const REMOVED = INHERITED_GROUP_SIDS.map(sid => `*${sid}`);
const INHERITED_PRIVATE = `O:${USER}G:${USER}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;${USER})`;
const posixOnly = process.platform === "win32" ? "POSIX modes and uids" : false;
const windowsOnly = process.platform === "win32" ? false : "needs real Windows ACLs";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "owner-private-fs-"));
}

/**
 * A fake WindowsSecurity: SDDL per path from a map (a protected path reads as
 * private unless the map says otherwise). Protect calls go in `calls`, reads
 * in `reads`, and `sid` lookups are not recorded.
 */
function fakeSecurity(sddl: Record<string, string | null> = {}, sid = USER) {
  const calls: string[] = [];
  const reads: string[] = [];
  const read = (paths: readonly string[]) => { reads.push(paths.join("|")); return paths.map(path => sddl[path] ?? null); };
  const protect = (path: string, kind: string) => { calls.push(`protect:${kind}:${path}`); if (!(path in sddl)) sddl[path] = kind === "directory" ? PRIVATE_FOLDER : PRIVATE_FILE; };
  // As the reader's "object:" request: the SDDL and the bytes of what the path names now.
  const readObjects = (paths: readonly string[]) => {
    reads.push(`object:${paths.join("|")}`);
    return paths.map(path => { const answer = sddl[path]; if (!answer) return null; try { return { sddl: answer, data: readFileSync(path) }; } catch { return null; } });
  };
  // As "upgrade:": an Administrators-only file becomes this account's, private.
  const upgrade = (path: string) => {
    if (!sddlHasOnlyAdministratorAccess(sddl[path], sid)) return null;
    calls.push(`upgrade:${path}`);
    sddl[path] = PRIVATE_FILE;
    return PRIVATE_FILE;
  };
  const security: WindowsSecurity = {
    async currentUserSid() { return sid; },
    currentUserSidSync() { return sid; },
    async readSddl(paths) { return read(paths); },
    readSddlSync(paths) { return read(paths); },
    async readObjects(paths) { return readObjects(paths); },
    readObjectsSync(paths) { return readObjects(paths); },
    async upgradeObject(path) { return upgrade(path); },
    upgradeObjectSync(path) { return upgrade(path); },
    async protect(path, kind) { protect(path, kind); },
    protectSync(path, kind) { protect(path, kind); },
  };
  return { security, calls, reads, sddl };
}

test("Windows tools run by absolute System32 path, from SystemRoot or the default Windows folder", () => {
  assert.equal(windowsSystemTool("icacls.exe", { SystemRoot: "D:\\Win" }), "D:\\Win\\System32\\icacls.exe");
  assert.equal(windowsSystemTool("icacls.exe", { windir: "C:\\WINDOWS" }), "C:\\WINDOWS\\System32\\icacls.exe");
  // A relative or odd value is never used: a bare name would be searched in the current folder first.
  assert.equal(windowsSystemTool("icacls.exe", { SystemRoot: "Windows" }), "C:\\Windows\\System32\\icacls.exe");
  assert.equal(windowsSystemTool("icacls.exe", { SystemRoot: "C:\\x\"&calc" }), "C:\\Windows\\System32\\icacls.exe");
  assert.equal(windowsSystemTool("icacls.exe", {}), "C:\\Windows\\System32\\icacls.exe");
  assert.deepEqual(windowsToolPaths({ SystemRoot: "C:\\Windows" }), {
    whoami: "C:\\Windows\\System32\\whoami.exe",
    icacls: "C:\\Windows\\System32\\icacls.exe",
    powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  });
});

test("whoami's CSV answer gives the SID only; anything else is refused", () => {
  assert.equal(parseWhoamiUserSid(`"desktop-7\\runneradmin","${USER}"\r\n`), USER);
  assert.equal(parseWhoamiUserSid(`"DOMAINE\\Benutzer, ä","s-1-5-21-1-2-3-500"`), "S-1-5-21-1-2-3-500");
  assert.throws(() => parseWhoamiUserSid("INFO: no user"), { code: "EOWNERPRIVATE" });
  assert.throws(() => parseWhoamiUserSid(`"a","S-1-"`), { code: "EOWNERPRIVATE" });
  assert.deepEqual(parseWhoamiUser(`"runnervm1\\runneradmin","S-1-5-21-1-2-3-500"\r\n`), { sid: "S-1-5-21-1-2-3-500", domain: "runnervm1" });
});

test("icacls gets a protected DACL for only this account and SYSTEM; folders pass it to new children", () => {
  assert.deepEqual(icaclsProtectArguments("C:\\Users\\me\\.letagents\\key", "file", USER),
    ["C:\\Users\\me\\.letagents\\key", "/inheritance:r", "/remove:g", ...REMOVED, "/grant:r", `*${USER}:F`, "*S-1-5-18:F", "/q"]);
  assert.deepEqual(icaclsProtectArguments("C:\\Users\\me\\.letagents", "directory", USER),
    ["C:\\Users\\me\\.letagents", "/inheritance:r", "/remove:g", ...REMOVED, "/grant:r", `*${USER}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/q"]);
  assert.throws(() => icaclsProtectArguments("relative\\key", "file", USER), { code: "EOWNERPRIVATE" });
  assert.throws(() => icaclsProtectArguments("C:\\key", "file", "Everyone"), { code: "EOWNERPRIVATE" });
});

test("the default Windows security runs whoami, PowerShell Get-Acl and icacls with these exact arguments", async () => {
  const env = { SystemRoot: "C:\\Windows", PATH: "C:\\bin" };
  const calls: { file: string; args: readonly string[]; paths?: string }[] = [];
  const answer = (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
    calls.push({ file, args, paths: options.env.LETAGENTS_OWNER_PRIVATE_PATHS });
    if (file.endsWith("whoami.exe")) return `"host\\me","${USER}"\r\n`;
    if (file.endsWith("powershell.exe")) {
      const paths = options.env.LETAGENTS_OWNER_PRIVATE_PATHS!.split("\n");
      return paths.map(path => (path.endsWith("missing") ? "error:" : `ok:${PRIVATE_FILE}`)).join("\r\n") + "\r\n";
    }
    return "";
  };
  const security = createWindowsSecurity({ env, run: async (...args) => answer(...args), runSync: answer });
  assert.equal(await security.currentUserSid(), USER);
  assert.equal(security.currentUserSidSync(), USER);
  assert.deepEqual(await security.readSddl(["C:\\a", "C:\\b missing"]), [PRIVATE_FILE, null]);
  assert.deepEqual(security.readSddlSync(["C:\\a"]), [PRIVATE_FILE]);
  await security.protect("C:\\a", "file");
  security.protectSync("C:\\d", "directory");

  // whoami runs once: the SID is kept for the life of the process.
  assert.equal(calls.filter(call => call.file.endsWith("whoami.exe")).length, 1);
  assert.deepEqual(calls[0], { file: "C:\\Windows\\System32\\whoami.exe", args: ["/user", "/fo", "csv", "/nh"], paths: undefined });
  const powershell = calls.find(call => call.file.endsWith("powershell.exe"))!;
  assert.equal(powershell.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(powershell.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  // .NET only (no cmdlet, so no module loads): the owner, group and DACL of the path.
  assert.match(String(powershell.args[4]), /\[System\.IO\.File\]::GetAccessControl\(\$p, \$sections\)/);
  assert.doesNotMatch(String(powershell.args[4]), /Get-Acl|New-Object|Where-Object/);
  assert.match(String(powershell.args[4]), /\$env:LETAGENTS_OWNER_PRIVATE_PATHS/);
  // The paths travel as JSON in the environment, never in the command text.
  assert.equal(powershell.paths, "C:\\a\nC:\\b missing");
  // One path per line, and PowerShell splits on the line break (`n), not on JSON.
  assert.match(String(powershell.args[4]), /-split "`n"/);
  assert.throws(() => encodeSddlPaths(["C:\\a\nb"]), { code: "EOWNERPRIVATE" });
  assert.ok(!String(powershell.args[4]).includes("C:\\a"));
  // Owner first (an elevated administrator's files are owned by Administrators), then the DACL.
  assert.deepEqual(calls.filter(call => call.file.endsWith("icacls.exe")).map(call => [call.file, call.args]), [
    ["C:\\Windows\\System32\\icacls.exe", ["C:\\a", "/setowner", `*${USER}`, "/q"]],
    ["C:\\Windows\\System32\\icacls.exe", ["C:\\a", "/inheritance:r", "/remove:g", ...REMOVED, "/grant:r", `*${USER}:F`, "*S-1-5-18:F", "/q"]],
    ["C:\\Windows\\System32\\icacls.exe", ["C:\\d", "/setowner", `*${USER}`, "/q"]],
    ["C:\\Windows\\System32\\icacls.exe", ["C:\\d", "/inheritance:r", "/remove:g", ...REMOVED, "/grant:r", `*${USER}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/q"]],
  ]);
});

test("Windows: a protect reads the owner, sets owner + DACL, reads back; nothing runs again for what it made", async () => {
  const root = scratch();
  try {
    const folder = join(root, "state");
    mkdirSync(folder);
    const calls: string[][] = [];
    const runner = (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
      const tool = file.split("\\").pop()!;
      calls.push([tool, ...args.slice(1, 2)]);
      if (tool === "whoami.exe") return `"host\\me","${USER}"`;
      if (tool === "powershell.exe") return options.env.LETAGENTS_OWNER_PRIVATE_PATHS!.split("\n").map(() => `ok:${PRIVATE_FOLDER}`).join("\r\n");
      return "";
    };
    const security = createWindowsSecurity({ env: { SystemRoot: "C:\\Windows" }, run: async (...args) => runner(...args), runSync: runner });
    const options = { platform: "win32" as const, windowsSecurity: security };
    await protectOwnerPrivate(folder, "directory", options);
    // The owner is read first (an existing entry may be another account's), then owner, DACL, read-back.
    assert.deepEqual(calls, [["powershell.exe", "-NoProfile"], ["whoami.exe", "/fo"], ["icacls.exe", "/setowner"], ["icacls.exe", "/inheritance:r"], ["powershell.exe", "-NoProfile"]]);
    calls.length = 0;
    // Made by the helper inside the verified folder: known, so nothing runs again.
    await writePrivateFileAtomically(join(folder, "token"), "t", options);
    await protectOwnerPrivate(join(folder, "token"), "file", options);
    protectOwnerPrivateSync(join(folder, "token"), "file", options);
    await createPrivateDir(join(folder, "sub"), {}, options);
    assert.equal(await isOwnerPrivate(join(folder, "token"), lstatSync(join(folder, "token")), options), true);
    assert.deepEqual(calls, []);
    // A file that was not made through the helper is protected in full (it may be another account's).
    writeFileSync(join(folder, "plain"), "p");
    await protectOwnerPrivate(join(folder, "plain"), "file", options);
    assert.deepEqual(calls.map(call => call[0]), ["powershell.exe", "icacls.exe", "icacls.exe", "powershell.exe"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows: a protect refuses an entry that was replaced during it", async () => {
  const root = scratch();
  try {
    const file = join(root, "token");
    writeFileSync(file, "ours");
    const { security } = fakeSecurity({ [file]: `O:${USER}D:AI(A;ID;FA;;;BU)` });
    const swapping: WindowsSecurity = {
      ...security,
      // Made before the old one goes, so it is a different file on every file system.
      async protect(path, kind) { await security.protect(path, kind); writeFileSync(`${path}.new`, "theirs"); renameSync(`${path}.new`, path); },
    };
    await assert.rejects(protectOwnerPrivate(file, "file", { platform: "win32", windowsSecurity: swapping }), /was replaced/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A stand-in for the long-lived PowerShell reader: answers each path line, "done:" for an empty line. */
function fakeReader(answer: (path: string) => string) {
  const starts: number[] = [];
  const children: EventEmitter[] = [];
  const start = () => {
    starts.push(1);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { child.emit("exit", 1); } });
    let pending = "";
    child.stdin.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        child.stdout.write(line === "" ? "done:\r\n" : `${answer(line)}\r\n`);
      }
    });
    children.push(child);
    return child as unknown as ChildProcess;
  };
  return { start, starts, children };
}

test("Windows: asynchronous reads share one long-lived reader; other paths and a stopped reader fall back", async () => {
  const fake = fakeReader(path => (path.endsWith("missing") ? "error:" : `ok:${PRIVATE_FILE}`));
  const oneShot: string[] = [];
  const security = createWindowsSecurity({
    env: { SystemRoot: "C:\\Windows" },
    startServer: fake.start,
    run: async (_file, _args, options) => {
      const paths = options.env.LETAGENTS_OWNER_PRIVATE_PATHS!.split("\n");
      oneShot.push(...paths);
      return paths.map(() => `ok:${PRIVATE_FILE}`).join("\n");
    },
  });
  assert.deepEqual(await security.readSddl(["C:\\a", "C:\\b missing"]), [PRIVATE_FILE, null]);
  assert.deepEqual(await Promise.all([security.readSddl(["C:\\c"]), security.readSddl(["C:\\d", "C:\\e"])]), [[PRIVATE_FILE], [PRIVATE_FILE, PRIVATE_FILE]]);
  assert.equal(fake.starts.length, 1);
  assert.deepEqual(oneShot, []);
  // A path that is not printable ASCII goes to the one-shot read (no code-page guessing).
  assert.deepEqual(await security.readSddl(["C:\\Users\\José\\x"]), [PRIVATE_FILE]);
  assert.deepEqual(oneShot, ["C:\\Users\\José\\x"]);
  // A reader that stops is not started again; reads fall back.
  fake.children[0]!.emit("exit", 1);
  assert.deepEqual(await security.readSddl(["C:\\f"]), [PRIVATE_FILE]);
  assert.equal(fake.starts.length, 1);
  assert.deepEqual(oneShot.at(-1), "C:\\f");
  // A reader that answers the wrong number of lines is refused, not guessed.
  const short = createSddlServer(fakeReader(() => "").start);
  await assert.rejects(short.read(["C:\\a"]), { code: "EOWNERPRIVATE" });
});

test("a long-lived reader that writes a line longer than any answer is stopped; the read falls back", async () => {
  const runaway = () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { child.emit("exit", 1); } });
    child.stdin.on("data", () => { for (let index = 0; index < 17; index += 1) child.stdout.write("x".repeat(1024 * 1024)); });
    return child as unknown as ChildProcess;
  };
  const reader = createSddlServer(runaway);
  await assert.rejects(reader.read(["C:\\a"]), { code: "EOWNERPRIVATE" });
  assert.equal(reader.usable, false);
  const overflowing = "process.stdin.once('data', () => { const chunk = 'x'.repeat(1 << 20); for (let i = 0; i < 17; i += 1) process.stdout.write(chunk); });";
  const sync = createSyncSddlServer(syncSddlReaderWorker(process.execPath, ["-e", overflowing]));
  assert.throws(() => sync.read(["C:\\a"]), { code: "EOWNERPRIVATE" });
  assert.equal(sync.usable, false);
});

test("many paths are read in a few PowerShell calls, each under the Windows environment limit", async () => {
  const sizes: number[] = [];
  const security = createWindowsSecurity({
    env: { SystemRoot: "C:\\Windows" },
    run: async (file, _args, options) => {
      if (file.endsWith("whoami.exe")) return `"h\\me","${USER}"`;
      const paths = options.env.LETAGENTS_OWNER_PRIVATE_PATHS!.split("\n");
      sizes.push(options.env.LETAGENTS_OWNER_PRIVATE_PATHS!.length);
      return paths.map(() => `ok:${PRIVATE_FILE}`).join("\n");
    },
  });
  const paths = Array.from({ length: 900 }, (_, index) => `C:\\Users\\me\\.cursor\\chats\\${"x".repeat(60)}\\${index}`);
  const answers = await security.readSddl(paths);
  assert.equal(answers.length, 900);
  assert.ok(sizes.length > 1);
  assert.ok(sizes.every(size => size < 32_767));
});

test("a PowerShell answer with the wrong number of lines is refused, not guessed", () => {
  assert.deepEqual(parseSddlLines("noise\r\nok:O:SYD:P\r\nerror:\r\n", 2), ["O:SYD:P", null]);
  assert.throws(() => parseSddlLines("ok:O:SYD:P", 2), { code: "EOWNERPRIVATE" });
});

test("SDDL parsing reads the owner and every DACL entry", () => {
  assert.deepEqual(parseSddl(PRIVATE_FOLDER), {
    owner: USER,
    dacl: { flags: "PAI", aces: [
      { type: "A", flags: "OICI", rights: "FA", sid: "SY" },
      { type: "A", flags: "OICI", rights: "FA", sid: USER },
    ] },
  });
  for (const unreadable of ["", "garbage", `O:${USER}D:P(A;;FA;;;SY`, `O:${USER}D:P(A;;FA)`, `O:${USER}X:P`, null]) {
    assert.equal(parseSddl(unreadable), null, String(unreadable));
  }
});

test("only an owned, protected DACL with entries for this account and SYSTEM is private", () => {
  assert.equal(sddlIsOwnerPrivate(PRIVATE_FILE, USER), true);
  assert.equal(sddlIsOwnerPrivate(PRIVATE_FOLDER, USER), true);
  assert.equal(sddlIsOwnerPrivate(`O:${USER}D:P(A;;FA;;;S-1-5-18)(A;;FA;;;${USER.toLowerCase()})`, USER), true);
  // A deny entry only takes access away.
  assert.equal(sddlIsOwnerPrivate(`O:${USER}D:P(D;;FA;;;WD)(A;;FA;;;${USER})`, USER), true);

  // This machine's built-in Administrator (RID 500) is written as "LA"; it is the
  // user only when the user is that local account (aliases from userSidAliases).
  const ADMIN = "S-1-5-21-3776380004-1005456608-3524014338-500";
  const ADMIN_SDDL = "O:LAG:S-1-5-21-1-2-3-513D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;LA)";
  assert.equal(sddlIsOwnerPrivate(ADMIN_SDDL, { sid: ADMIN, aliases: ["LA"] }), true);
  assert.equal(sddlIsOwnerPrivate(ADMIN_SDDL, ADMIN), false);
  assert.deepEqual(userSidAliases({ sid: ADMIN, domain: "runnervm1" }, "RUNNERVM1"), ["LA"]);
  assert.deepEqual(userSidAliases({ sid: ADMIN, domain: "CORP" }, "RUNNERVM1"), []);
  assert.deepEqual(userSidAliases({ sid: USER, domain: "runnervm1" }, "RUNNERVM1"), []);
  assert.deepEqual(userSidAliases({ sid: ADMIN, domain: null }, "RUNNERVM1"), []);
  assert.equal(sddlIsOwnerPrivate("O:LAD:P(A;;FA;;;LA)", USER), false);
  assert.equal(sddlIsOwnerPrivate(`O:${USER}D:P(A;;FA;;;LA)(A;;FA;;;${USER})`, USER), false);

  const refused: Record<string, string> = {
    "another owner": `O:${OTHER}D:P(A;;FA;;;${USER})`,
    "Administrators own it": `O:BAD:P(A;;FA;;;${USER})`,
    "inheritance on (no P)": `O:${USER}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;${USER})`,
    "Everyone may read": `O:${USER}D:P(A;;FR;;;WD)(A;;FA;;;${USER})`,
    "Administrators allowed": `O:${USER}D:P(A;;FA;;;BA)(A;;FA;;;${USER})`,
    "Users allowed": `O:${USER}D:P(A;;FA;;;BU)(A;;FA;;;${USER})`,
    "another user allowed": `O:${USER}D:P(A;;FR;;;${OTHER})(A;;FA;;;${USER})`,
    "an inherit-only entry for Everyone": `O:${USER}D:P(A;OICIIO;FA;;;WD)(A;;FA;;;${USER})`,
    "an object allow entry for another user": `O:${USER}D:P(OA;;FA;;;${OTHER})(A;;FA;;;${USER})`,
    "a conditional entry": `O:${USER}D:P(XA;;FA;;;WD;(Member_of {SID(BA)}))(A;;FA;;;${USER})`,
    "an audit entry type in the DACL": `O:${USER}D:P(AU;;FA;;;${USER})`,
    "a null DACL": `O:${USER}D:NO_ACCESS_CONTROL`,
    "no DACL": `O:${USER}G:${USER}`,
  };
  for (const [reason, sddl] of Object.entries(refused)) assert.equal(sddlIsOwnerPrivate(sddl, USER), false, reason);
});

test("POSIX checks read only the stat: the mode and uid rules are today's", { skip: posixOnly }, async () => {
  const { security, calls } = fakeSecurity();
  const uid = process.getuid!();
  const options = { platform: process.platform, windowsSecurity: security };
  assert.equal(await isOwnerPrivate("/x", { mode: 0o100600, uid }, options), true);
  assert.equal(await isOwnerPrivate("/x", { mode: 0o100700, uid }, options), true);
  assert.equal(await isOwnerPrivate("/x", { mode: 0o100640, uid }, options), false);
  assert.equal(await isOwnerPrivate("/x", { mode: 0o100601, uid }, options), false);
  assert.equal(await isOwnerPrivate("/x", { mode: 0o100600, uid: uid + 1 }, options), false);
  assert.equal(isOwnerPrivateSync("/x", { mode: 0o100600, uid }, { ...options, exactMode: 0o600 }), true);
  assert.equal(isOwnerPrivateSync("/x", { mode: 0o100400, uid }, { ...options, exactMode: 0o600 }), false);
  assert.equal(isOwnerPrivateSync("/x", { mode: 0o40700, uid }, { ...options, exactMode: 0o700 }), true);
  assert.equal(isOwnerPrivateSync("/x", { mode: 0o40500, uid }, { ...options, exactMode: 0o700 }), false);
  assert.equal(await isOwnedByCurrentUser("/x", { mode: 0o100666, uid }, options), true);
  assert.equal(await isOwnedByCurrentUser("/x", { mode: 0o100600, uid: uid + 1 }, options), false);
  assert.equal(everyOwnedByCurrentUserSync([{ path: "/a", info: { mode: 0, uid } }, { path: "/b", info: { mode: 0, uid: uid + 1 } }], options), false);
  assert.deepEqual(calls, []);
});

test("Windows checks ignore mode bits and read the path, and the folders above it, in one call", async () => {
  const root = scratch();
  try {
    const folder = join(root, "state");
    mkdirSync(folder);
    for (const name of ["token", "second", "open", "theirs"]) writeFileSync(join(folder, name), "x");
    const { security, reads, sddl } = fakeSecurity({
      [folder]: PRIVATE_FOLDER,
      [join(folder, "token")]: INHERITED_PRIVATE,
      [join(folder, "open")]: `O:${USER}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;${USER})(A;;FR;;;BU)`,
      [join(folder, "theirs")]: `O:${OTHER}D:AI(A;ID;FA;;;SY)`,
    });
    const options = { platform: "win32" as const, windowsSecurity: security };
    const sddlFor = (path: string, value: string) => { sddl[path] = value; };
    // Node reports 0o666 and uid 0 for every Windows file; neither decides.
    const windowsStat = { mode: 0o100666, uid: 0 };
    // A cold check reads the file and every folder above it in one call.
    assert.equal(await isOwnerPrivate(join(folder, "open"), windowsStat, options), false);
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0]!.split("|").slice(0, 3), [join(folder, "open"), folder, root]);
    assert.equal(await isOwnerPrivate(join(folder, "theirs"), windowsStat, options), false);
    // Inherited private entries under a protected private folder: private, and the folder is now verified.
    assert.equal(await isOwnerPrivate(join(folder, "token"), windowsStat, options), true);
    // A known entry is not read again.
    let before = reads.length;
    assert.equal(await isOwnerPrivate(join(folder, "token"), windowsStat, options), true);
    assert.equal(reads.length, before);
    // Another entry in the verified folder is read once, by itself (it may predate the folder's DACL).
    sddlFor(join(folder, "second"), INHERITED_PRIVATE);
    assert.equal(isOwnerPrivateSync(join(folder, "second"), windowsStat, { ...options, exactMode: 0o600 }), true);
    assert.equal(reads.at(-1), join(folder, "second"));
    // Another account's entry, or one with an extra entry, is refused even under a verified folder.
    assert.equal(await isOwnedByCurrentUser(join(folder, "theirs"), windowsStat, options), false);
    assert.equal(everyOwnerPrivateSync([{ path: join(folder, "open"), info: windowsStat }], options), false);
    // A path outside it reads the whole chain again.
    writeFileSync(join(root, "outside"), "x");
    before = reads.length;
    assert.equal(await isOwnerPrivate(join(root, "outside"), windowsStat, options), false);
    assert.equal(reads.length, before + 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows: checkObject reads a known secret's own DACL again and refuses a grant added later", async () => {
  const root = scratch();
  try {
    const folder = join(root, "state");
    mkdirSync(folder);
    const secret = join(folder, "secret");
    writeFileSync(secret, "x");
    const { security, reads, sddl } = fakeSecurity({ [folder]: PRIVATE_FOLDER, [secret]: INHERITED_PRIVATE });
    const options = { platform: "win32" as const, windowsSecurity: security };
    const windowsStat = { mode: 0o100666, uid: 0 };
    assert.equal(await isOwnerPrivate(secret, windowsStat, options), true);
    // Someone adds an explicit grant to the file itself; the folder stays private.
    sddl[secret] = `O:${USER}D:AI(A;;FR;;;WD)(A;ID;FA;;;SY)(A;ID;FA;;;${USER})`;
    // The cache (folders verified once) still answers for an ordinary check: unchanged #1801 behaviour.
    let before = reads.length;
    assert.equal(await isOwnerPrivate(secret, windowsStat, options), true);
    assert.equal(reads.length, before, "an ordinary check of a known entry reads nothing");
    // checkObject reads the file's own DACL, and only the file (its folder is verified).
    before = reads.length;
    assert.equal(await isOwnerPrivate(secret, windowsStat, { ...options, checkObject: true }), false);
    assert.equal(isOwnerPrivateSync(secret, windowsStat, { ...options, checkObject: true }), false);
    assert.deepEqual(reads.slice(before), [secret, secret]);
    // Restored to private, checkObject passes again.
    sddl[secret] = INHERITED_PRIVATE;
    assert.equal(await isOwnerPrivate(secret, windowsStat, { ...options, checkObject: true }), true);
  } finally { rmSync(root, { recursive: true, force: true }); forgetOwnerPrivateCache(); }
});

test("Windows: an entry another account left in a folder before it was verified is never trusted", async () => {
  const root = scratch();
  try {
    const folder = join(root, "state");
    mkdirSync(folder);
    writeFileSync(join(folder, "planted"), "x");
    const { security, calls, sddl } = fakeSecurity({
      [folder]: `O:${USER}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${USER})`,
      [join(folder, "planted")]: `O:${OTHER}D:P(A;;FA;;;${USER})(A;;FA;;;${OTHER})`,
    });
    const options = { platform: "win32" as const, windowsSecurity: security };
    // The folder becomes private (and is verified here) after the entry was planted in it.
    sddl[folder] = PRIVATE_FOLDER;
    assert.equal(await isOwnerPrivate(folder, lstatSync(folder), options), true);
    const stat = lstatSync(join(folder, "planted"));
    assert.equal(await isOwnerPrivate(join(folder, "planted"), stat, options), false);
    assert.equal(await isOwnedByCurrentUser(join(folder, "planted"), stat, options), false);
    // A protect of it fails with EPERM, as chmod does on another account's file, and icacls never
    // runs: its DACL grants this account full control, so icacls would take the file over.
    calls.length = 0;
    await assert.rejects(protectOwnerPrivate(join(folder, "planted"), "file", options), { code: "EPERM" });
    await assert.rejects(protectOwnerPrivate(join(folder, "planted"), "file", { ...options, force: true }), { code: "EPERM" });
    assert.throws(() => protectOwnerPrivateSync(join(folder, "planted"), "file", options), { code: "EPERM" });
    assert.deepEqual(calls, []);
    // An entry Administrators own (what an elevated process makes) is this machine's admins': it is protected.
    writeFileSync(join(folder, "elevated"), "e");
    sddl[join(folder, "elevated")] = `O:BAD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)`;
    await assert.rejects(protectOwnerPrivate(join(folder, "elevated"), "file", options), { code: "EOWNERPRIVATE" });
    assert.deepEqual(calls, [`protect:file:${join(folder, "elevated")}`]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows: a verified folder that is renamed away and replaced is not trusted", async () => {
  const root = scratch();
  try {
    const folder = join(root, "state");
    const { security, reads } = fakeSecurity();
    const options = { platform: "win32" as const, windowsSecurity: security };
    await createPrivateDir(folder, {}, options);
    await writePrivateFileAtomically(join(folder, "token"), "t", options);
    renameSync(folder, join(root, "moved"));
    mkdirSync(folder);
    writeFileSync(join(folder, "token"), "attacker");
    const before = reads.length;
    assert.equal(await isOwnerPrivate(join(folder, "token"), lstatSync(join(folder, "token")), options), false);
    assert.ok(reads.length > before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows: a private folder that passes nothing on does not vouch for new entries", async () => {
  const root = scratch();
  try {
    const folder = join(root, "flat");
    mkdirSync(folder);
    // Private and protected, but its entries are not inherited (no OI/CI): a new child would get the creator's default DACL.
    const { security, calls } = fakeSecurity({ [folder]: `O:${USER}D:P(A;;FA;;;SY)(A;;FA;;;${USER})` });
    const options = { platform: "win32" as const, windowsSecurity: security };
    assert.equal(await isOwnerPrivate(folder, lstatSync(folder), options), true);
    writeFileSync(join(folder, "new"), "n");
    await privateEntryCreated(join(folder, "new"), "file", options);
    assert.deepEqual(calls, [`protect:file:${join(folder, "new")}`]);
    assert.equal(sddlPassesPrivateEntriesOn(PRIVATE_FOLDER, USER), true);
    assert.equal(sddlPassesPrivateEntriesOn(`O:${USER}D:P(A;;FA;;;${USER})`, USER), false);
    assert.equal(sddlPassesPrivateEntriesOn(`O:${USER}D:P(A;OI;FA;;;${USER})`, USER), false);
    // NP (no propagation): children get it, grandchildren do not.
    assert.equal(sddlPassesPrivateEntriesOn(`O:${USER}D:P(A;OICINP;FA;;;${USER})(A;OICI;FA;;;SY)`, USER), false);
    assert.equal(sddlPassesPrivateEntriesOn(`O:${USER}D:P(A;OICIIO;FA;;;${USER})`, USER), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows: an object swapped in while its permissions are read is not remembered", async () => {
  const root = scratch();
  try {
    const folder = join(root, "state");
    mkdirSync(folder);
    const { security, reads } = fakeSecurity({ [folder]: PRIVATE_FOLDER });
    let swapped = false;
    const swapping: WindowsSecurity = {
      ...security,
      async readSddl(paths) {
        const answers = await security.readSddl(paths);
        // Once: another account replaces the folder after its private DACL was read.
        if (!swapped) { swapped = true; renameSync(folder, join(root, "gone")); mkdirSync(folder); }
        return answers;
      },
    };
    const options = { platform: "win32" as const, windowsSecurity: swapping };
    assert.equal(await isOwnerPrivate(folder, lstatSync(folder), options), false);
    // The replacement was not cached: the next check reads it again (this fake answers by path).
    const before = reads.length;
    await isOwnerPrivate(folder, lstatSync(folder), options);
    assert.ok(reads.length > before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows: a chain is private only up to a protected folder, and every level on the way must be private", async () => {
  const root = scratch();
  try {
    const a = join(root, "a");
    const b = join(a, "b");
    mkdirSync(b, { recursive: true });
    writeFileSync(join(b, "f"), "x");
    const stat = { mode: 0o666, uid: 0 };
    const check = (map: Record<string, string>) => isOwnerPrivate(join(b, "f"), stat, { platform: "win32", windowsSecurity: fakeSecurity(map).security });
    assert.equal(await check({ [a]: PRIVATE_FOLDER, [b]: INHERITED_PRIVATE, [join(b, "f")]: INHERITED_PRIVATE }), true);
    // No protected folder anywhere above: not private.
    assert.equal(await check({ [a]: INHERITED_PRIVATE, [b]: INHERITED_PRIVATE, [join(b, "f")]: INHERITED_PRIVATE }), false);
    // A level on the way that grants Users: not private, though a protected folder is above it.
    assert.equal(await check({ [a]: PRIVATE_FOLDER, [b]: `O:${USER}D:AI(A;ID;FA;;;${USER})(A;;FR;;;BU)`, [join(b, "f")]: INHERITED_PRIVATE }), false);
    // A file with a protected DACL of its own is private wherever it is.
    assert.equal(await check({ [join(b, "f")]: PRIVATE_FILE }), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("on Windows a tool failure counts as not private", async () => {
  const failing: WindowsSecurity = {
    async currentUserSid() { throw new Error("whoami blocked"); },
    currentUserSidSync() { throw new Error("whoami blocked"); },
    async readSddl() { throw new Error("PowerShell blocked"); },
    readSddlSync() { throw new Error("PowerShell blocked"); },
    async protect() { throw new Error("icacls blocked"); },
    protectSync() { throw new Error("icacls blocked"); },
  };
  const options = { platform: "win32" as const, windowsSecurity: failing };
  assert.equal(await isOwnerPrivate("C:\\x", { mode: 0o666, uid: 0 }, options), false);
  assert.equal(isOwnerPrivateSync("C:\\x", { mode: 0o666, uid: 0 }, options), false);
  assert.equal(await isOwnedByCurrentUser("C:\\x", { mode: 0o666, uid: 0 }, options), false);
  assert.equal(everyOwnedByCurrentUserSync([{ path: "C:\\x", info: { mode: 0, uid: 0 } }], options), false);
});

test("POSIX: private folders are 0700, atomic private files 0600, and assertOwnerPrivate refuses open ones", { skip: posixOnly }, async () => {
  const root = scratch();
  try {
    const nested = join(root, "a", "b");
    await createPrivateDir(nested, { recursive: true });
    assert.equal(statSync(join(root, "a")).mode & 0o777, 0o700);
    assert.equal(statSync(nested).mode & 0o777, 0o700);
    createPrivateDirSync(join(root, "c"));
    assert.equal(statSync(join(root, "c")).mode & 0o777, 0o700);
    await assert.rejects(createPrivateDir(join(root, "c")), { code: "EEXIST" });

    const file = join(nested, "token.json");
    await writePrivateFileAtomically(file, "{\"a\":1}\n");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, "utf8"), "{\"a\":1}\n");
    writePrivateFileAtomicallySync(file, Buffer.from("two"));
    assert.equal(readFileSync(file, "utf8"), "two");
    await assertOwnerPrivate(file);
    await assertOwnerPrivate(nested, { kind: "directory" });

    const open = join(root, "open.json");
    writeFileSync(open, "{}", { mode: 0o644 });
    await assert.rejects(assertOwnerPrivate(open), { code: "EOWNERPRIVATE" });
    assert.throws(() => assertOwnerPrivateSync(open), { code: "EOWNERPRIVATE" });
    // A folder is not a file, and a link is never followed.
    await assert.rejects(assertOwnerPrivate(nested), { code: "EOWNERPRIVATE" });
    symlinkSync(file, join(root, "link"));
    await assert.rejects(assertOwnerPrivate(join(root, "link")), { code: "EOWNERPRIVATE" });
    await assert.rejects(openNoFollow(join(root, "link"), constants.O_RDONLY), { code: "ELOOP" });
    assert.throws(() => openNoFollowSync(join(root, "link"), constants.O_RDONLY), { code: "ELOOP" });
    await syncDirectory(nested);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows: only the first folder a mkdir makes is protected; the rest inherit; an existing one is left as it is", async () => {
  const root = scratch();
  try {
    const { security, calls } = fakeSecurity();
    const options = { platform: "win32" as const, windowsSecurity: security };
    await createPrivateDir(join(root, "a", "b", "c"), { recursive: true }, options);
    // `a` gets the private DACL; `a/b` and `a/b/c` inherit it. Never `root` or above.
    assert.deepEqual(calls, [`protect:directory:${join(root, "a")}`]);
    calls.length = 0;
    createPrivateDirSync(join(root, "a", "x", "y"), { recursive: true }, options);
    await createPrivateDir(join(root, "a", "b"), { recursive: true }, options);
    assert.deepEqual(calls, []);
    createPrivateDirSync(join(root, "d"), {}, options);
    assert.deepEqual(calls, [`protect:directory:${join(root, "d")}`]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows: a folder another process makes during a recursive mkdir is left alone", async () => {
  const root = scratch();
  try {
    const { security, calls } = fakeSecurity();
    // While `a` is being protected, "another process" makes `a/b`.
    const racing: WindowsSecurity = {
      ...security,
      async protect(path, kind) {
        await security.protect(path, kind);
        if (path === join(root, "a")) mkdirSync(join(root, "a", "b"));
      },
    };
    const made = await createPrivateDir(join(root, "a", "b", "c"), { recursive: true }, { platform: "win32", windowsSecurity: racing });
    assert.equal(made, join(root, "a"));
    // `a/b` is not this call's, so it is neither protected nor trusted: `c` in it gets its own DACL.
    assert.deepEqual(calls, [`protect:directory:${join(root, "a")}`, `protect:directory:${join(root, "a", "b", "c")}`]);
    // A file where a folder should be is still an error, as with mkdir.
    writeFileSync(join(root, "file"), "x");
    await assert.rejects(createPrivateDir(join(root, "file", "x"), { recursive: true }, { platform: "win32", windowsSecurity: security }));
    await assert.rejects(createPrivateDir(join(root, "file"), { recursive: true }, { platform: "win32", windowsSecurity: security }), { code: "EEXIST" });
    assert.throws(() => createPrivateDirSync(join(root, "file"), { recursive: true }, { platform: "win32", windowsSecurity: security }), { code: "EEXIST" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows: an atomic private write runs no tool in a private folder, and stages elsewhere", async () => {
  const root = scratch();
  try {
    const target = join(root, "state.json");
    const seen: string[] = [];
    const { security, calls, sddl } = fakeSecurity();
    const look = (path: string, kind: string) => { seen.push(kind === "file" ? readFileSync(path, "utf8") : readdirSync(path).join(",")); };
    const recording: WindowsSecurity = {
      ...security,
      async protect(path, kind) { look(path, kind); await security.protect(path, kind); },
      protectSync(path, kind) { look(path, kind); security.protectSync(path, kind); },
    };
    const options = { platform: "win32" as const, windowsSecurity: recording };
    // `root` is not private: each write makes a staging folder beside the target,
    // private while still empty; the file made inside it gets a protected DACL of
    // its own while still empty, so it stays private after the rename out.
    await writePrivateFileAtomically(target, "secret", options);
    writePrivateFileAtomicallySync(target, "secret 2", options);
    assert.equal(readFileSync(target, "utf8"), "secret 2");
    assert.deepEqual(seen, ["", "", "", ""]);
    assert.equal(calls.length, 4);
    for (const [index, call] of calls.entries()) {
      const match = /^protect:(directory|file):(.+)$/.exec(call)!;
      assert.equal(match[1], index % 2 ? "file" : "directory");
      const folder = index % 2 ? dirname(match[2]!) : match[2]!;
      assert.equal(dirname(folder), root);
      assert.match(basename(folder), /^\.state\.json\.letagents-/);
      if (index % 2) assert.equal(match[2], join(calls[index - 1]!.replace(/^protect:directory:/, ""), "data"));
    }
    assert.deepEqual(readdirSync(root), ["state.json"]);

    // In a private folder: no tool runs at all; the file inherits at creation.
    // (Linux may give the new folder a removed staging folder's inode: start from no known entries.)
    forgetOwnerPrivateCache();
    const folder = join(root, "private");
    mkdirSync(folder);
    sddl[folder] = PRIVATE_FOLDER;
    calls.length = 0;
    await writePrivateFileAtomically(join(folder, "token.json"), "t", options);
    writePrivateFileAtomicallySync(join(folder, "token.json"), "t2", options);
    assert.deepEqual(calls, []);
    assert.deepEqual(readdirSync(folder), ["token.json"]);
    assert.equal(readFileSync(join(folder, "token.json"), "utf8"), "t2");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows: openNoFollow refuses a link before opening and a swapped file after", { skip: posixOnly }, async () => {
  const root = scratch();
  try {
    const real = join(root, "real");
    writeFileSync(real, "x");
    symlinkSync(real, join(root, "link"));
    const options = { platform: "win32" as const };
    await assert.rejects(openNoFollow(join(root, "link"), constants.O_RDONLY, undefined, options), { code: "ELOOP" });
    assert.throws(() => openNoFollowSync(join(root, "link"), constants.O_RDONLY, undefined, options), { code: "ELOOP" });
    const handle = await openNoFollow(real, constants.O_RDONLY, undefined, options);
    await handle.close();
    const created = await openNoFollow(join(root, "new"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600, options);
    await created.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the async rename is retried on Windows only, with the same bounded waits", async () => {
  let attempts = 0;
  const waits: number[] = [];
  await renameWithRetryAsync("a", "b", {
    platform: "win32",
    rename: async () => { attempts += 1; if (attempts < 4) throw Object.assign(new Error("busy"), { code: "EBUSY" }); },
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(attempts, 4);
  assert.deepEqual(waits, RENAME_RETRY_DELAYS_MS.slice(0, 3));
  attempts = 0;
  await assert.rejects(renameWithRetryAsync("a", "b", {
    platform: "darwin",
    rename: async () => { attempts += 1; throw Object.assign(new Error("perm"), { code: "EPERM" }); },
    sleep: async () => undefined,
  }), { code: "EPERM" });
  assert.equal(attempts, 1);
});

test("the null device is /dev/null on POSIX and \\\\.\\nul on Windows", () => {
  assert.equal(nullDevice({ platform: "darwin" }), "/dev/null");
  assert.equal(nullDevice({ platform: "win32" }), "\\\\.\\nul");
});

test("Windows: protect reads the result back, removes leftover entries by SID, and otherwise throws", async () => {
  const root = scratch();
  try {
    const file = join(root, "token.json");
    writeFileSync(file, "{}");
    const leftover = `O:${USER}D:PAI(A;;FA;;;SY)(A;;FA;;;${USER})(A;;FR;;;${OTHER})(A;;FR;;;BA)`;
    const removed: string[][] = [];
    const { security, sddl } = fakeSecurity({ [file]: leftover });
    const withRemoval: WindowsSecurity = {
      ...security,
      async removeGrants(path, sids) { removed.push([...sids]); sddl[path] = PRIVATE_FILE; },
      removeGrantsSync(path, sids) { removed.push([...sids]); sddl[path] = PRIVATE_FILE; },
    };
    await protectOwnerPrivate(file, "file", { platform: "win32", windowsSecurity: withRemoval });
    assert.deepEqual(removed, [[OTHER, "S-1-5-32-544"]]);

    // No way to remove the leftover: throw, as a failed chmod would.
    sddl[file] = leftover;
    await assert.rejects(protectOwnerPrivate(file, "file", { platform: "win32", windowsSecurity: security }), { code: "EOWNERPRIVATE" });
    assert.throws(() => protectOwnerPrivateSync(file, "file", { platform: "win32", windowsSecurity: security }), { code: "EOWNERPRIVATE" });
    // A removal that does not take: throw.
    const stubborn: WindowsSecurity = { ...security, async removeGrants() {}, removeGrantsSync() {} };
    await assert.rejects(protectOwnerPrivate(file, "file", { platform: "win32", windowsSecurity: stubborn }), { code: "EOWNERPRIVATE" });
    // A missing path keeps chmod's ENOENT.
    await assert.rejects(protectOwnerPrivate(join(root, "missing"), "file", { platform: "win32", windowsSecurity: security }), { code: "ENOENT" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows: a tool that cannot start is EOWNERPRIVATE, never a missing file", async () => {
  const root = scratch();
  try {
    const file = join(root, "token.json");
    writeFileSync(file, "{}");
    const notStarting = () => { throw Object.assign(new Error("spawn C:\\Windows\\System32\\icacls.exe ENOENT"), { code: "ENOENT" }); };
    const security = createWindowsSecurity({ env: { SystemRoot: "C:\\Windows" }, run: async () => notStarting(), runSync: notStarting });
    const options = { platform: "win32" as const, windowsSecurity: security };
    await assert.rejects(protectOwnerPrivate(file, "file", options), { code: "EOWNERPRIVATE" });
    assert.throws(() => protectOwnerPrivateSync(file, "file", options), { code: "EOWNERPRIVATE" });
    // A backend that throws ENOENT itself (a native helper, say) is wrapped too.
    const owned = `O:${USER}D:AI(A;ID;FA;;;BU)`;
    const { security: fake } = fakeSecurity({ [file]: owned, [join(root, "vanishing")]: owned });
    const throwing: WindowsSecurity = { ...fake, async protect() { notStarting(); }, protectSync() { notStarting(); } };
    await assert.rejects(protectOwnerPrivate(file, "file", { platform: "win32", windowsSecurity: throwing }), { code: "EOWNERPRIVATE" });
    // Only a missing path itself is ENOENT.
    await assert.rejects(protectOwnerPrivate(join(root, "missing"), "file", options), { code: "ENOENT" });
    // A path another process removes while icacls runs on it is ENOENT too (as a chmod that lost the race).
    const vanishing = join(root, "vanishing");
    writeFileSync(vanishing, "v");
    const removing: WindowsSecurity = { ...fake, async protect(path) { rmSync(path); notStarting(); }, protectSync(path) { rmSync(path); notStarting(); } };
    await assert.rejects(protectOwnerPrivate(vanishing, "file", { platform: "win32", windowsSecurity: removing }), { code: "ENOENT" });
    writeFileSync(vanishing, "v");
    assert.throws(() => protectOwnerPrivateSync(vanishing, "file", { platform: "win32", windowsSecurity: removing }), { code: "ENOENT" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a fresh profile folder's access (user, SYSTEM, Administrators) is told apart from a shared one", () => {
  assert.equal(sddlHasProfileDefaultAccess(`O:${USER}D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`, USER), true);
  assert.equal(sddlHasProfileDefaultAccess(PRIVATE_FOLDER, USER), true);
  assert.equal(sddlHasProfileDefaultAccess(`O:${USER}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;${USER})(A;ID;0x1301bf;;;BU)`, USER), false);
  assert.equal(sddlHasProfileDefaultAccess(`O:${USER}D:AI(A;ID;FA;;;${OTHER})`, USER), false);
  assert.equal(sddlHasProfileDefaultAccess(`O:${OTHER}D:AI(A;ID;FA;;;SY)`, USER), false);
  assert.equal(sddlHasProfileDefaultAccess(`O:${USER}D:NO_ACCESS_CONTROL`, USER), false);
});

test("only extra allow entries with a known SID can be removed; anything else needs a new DACL", () => {
  assert.deepEqual(sddlExtraGrantSids(`O:${USER}D:P(A;;FA;;;${USER})(A;;FR;;;WD)(A;OICIIO;FA;;;CO)(D;;FA;;;BG)`, USER), ["S-1-1-0", "S-1-3-0"]);
  assert.deepEqual(sddlExtraGrantSids(PRIVATE_FOLDER, USER), []);
  assert.equal(sddlExtraGrantSids(`O:${USER}D:P(A;;FR;;;DU)`, USER), null);
  assert.equal(sddlExtraGrantSids(`O:${USER}D:AI(A;ID;FR;;;WD)`, USER), null);
  assert.equal(sddlExtraGrantSids(`O:${OTHER}D:P(A;;FR;;;WD)`, USER), null);
  assert.equal(sddlExtraGrantSids(`O:${USER}D:P(AU;;FR;;;WD)`, USER), null);
  assert.deepEqual(icaclsRemoveArguments("C:\\a", [OTHER, "S-1-1-0"]), ["C:\\a", "/remove:g", `*${OTHER}`, "*S-1-1-0", "/q"]);
  assert.throws(() => icaclsRemoveArguments("C:\\a", ["WD"]), { code: "EOWNERPRIVATE" });
});

test("Windows: a batch privacy check reads every path in one call", () => {
  const root = scratch();
  try {
    for (const name of ["a", "b", "c"]) writeFileSync(join(root, name), "x");
    const { security, reads } = fakeSecurity({ [join(root, "a")]: PRIVATE_FILE, [join(root, "b")]: PRIVATE_FOLDER, [join(root, "c")]: `O:${USER}D:AI(A;ID;FA;;;BU)` });
    const options = { platform: "win32" as const, windowsSecurity: security };
    const stat = { mode: 0o666, uid: 0 };
    assert.equal(everyOwnerPrivateSync([{ path: join(root, "a"), info: stat }, { path: join(root, "b"), info: stat }], options), true);
    assert.equal(everyOwnerPrivateSync([{ path: join(root, "a"), info: stat }, { path: join(root, "c"), info: stat }], options), false);
    assert.equal(reads.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows: the built-in Administrator alias is resolved from whoami and the computer name", () => {
  const answer = (domain: string) => () => `"${domain}\\Administrator","S-1-5-21-1-2-3-500"`;
  const local = createWindowsSecurity({ env: { SystemRoot: "C:\\Windows", COMPUTERNAME: "HOST1" }, runSync: answer("host1") });
  assert.deepEqual(local.currentUserAliasesSync!(), ["LA"]);
  const domain = createWindowsSecurity({ env: { SystemRoot: "C:\\Windows", COMPUTERNAME: "HOST1" }, runSync: answer("CORP") });
  assert.deepEqual(domain.currentUserAliasesSync!(), []);
});

test("Windows: a check is bound to the caller's file; a path that names another file now is refused", async () => {
  const root = scratch();
  try {
    const opened = join(root, "opened");
    const swapped = join(root, "swapped");
    writeFileSync(opened, "a");
    writeFileSync(swapped, "b");
    const { security } = fakeSecurity({ [opened]: PRIVATE_FILE, [swapped]: PRIVATE_FILE });
    const options = { platform: "win32" as const, windowsSecurity: security };
    const openedInfo = lstatSync(opened);
    assert.equal(await isOwnerPrivate(opened, openedInfo, options), true);
    // The caller holds `opened`, but the path now names `swapped`: refused, private or not.
    assert.equal(await isOwnerPrivate(swapped, openedInfo, options), false);
    assert.equal(isOwnerPrivateSync(swapped, openedInfo, options), false);
    assert.equal(await isOwnedByCurrentUser(swapped, openedInfo, options), false);
    assert.equal(everyOwnerPrivateSync([{ path: swapped, info: openedInfo }], options), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- real Windows

// ---------------------------------------------------------------- high-value secret files

/** Move a file's change time (and write time) as a DACL change does on NTFS. */
function touch(path: string, seconds: number): void {
  utimesSync(path, seconds, seconds);
}

test("POSIX: a secret is read exactly as readFileSync and readFile read it, and no Windows tool is asked", { skip: posixOnly }, async () => {
  const root = scratch();
  try {
    const file = join(root, "token.json");
    writeFileSync(file, "{\"token\":\"t\"}", { mode: 0o644 });
    const { security, reads, calls } = fakeSecurity();
    // A mode that POSIX callers never refused here is still read: the rule is unchanged.
    assert.equal(readOwnerPrivateFileSync(file, "utf8"), readFileSync(file, "utf8"));
    assert.deepEqual(readOwnerPrivateFileSync(file), readFileSync(file));
    assert.equal(await readOwnerPrivateFile(file, "utf8"), await readFile(file, "utf8"));
    assert.deepEqual(await readOwnerPrivateFile(file), await readFile(file));
    assert.throws(() => readOwnerPrivateFileSync(join(root, "missing")), { code: "ENOENT" });
    await assert.rejects(readOwnerPrivateFile(join(root, "missing")), { code: "ENOENT" });
    ensurePrivateStateFolderSync(root, { windowsSecurity: security });
    assert.equal(statSync(root).mode & 0o777, statSync(root).mode & 0o777);
    assert.deepEqual([reads, calls], [[], []]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows: a secret this process wrote is read with no tool; a cold read checks its own DACL once, then never while it is unchanged", async () => {
  const root = scratch();
  try {
    const folder = join(root, "state");
    mkdirSync(folder);
    const file = join(folder, "mcp-state.json");
    const { security, reads, calls, sddl } = fakeSecurity({ [folder]: PRIVATE_FOLDER });
    const options = { platform: "win32" as const, windowsSecurity: security };
    writePrivateFileAtomicallySync(file, "{\"token\":\"t\"}", options);
    await writePrivateFileAtomically(file, "{\"token\":\"t2\"}", options);
    sddl[file] = INHERITED_PRIVATE;
    let before = reads.length;
    assert.equal(readOwnerPrivateFileSync(file, "utf8", options), "{\"token\":\"t2\"}");
    assert.equal(await readOwnerPrivateFile(file, "utf8", options), "{\"token\":\"t2\"}");
    // Unchanged since the write, it needs no read. A rename may move the change time (POSIX does, and
    // Windows Server can): then the next read checks the file once, through the reader (no protect).
    assert.ok(reads.length - before <= 1, "the writer's own file needs at most one read");
    // A cold process (another MCP worker): the file's own DACL and the folders up to a protected one, in one read.
    forgetOwnerPrivateCache();
    before = reads.length;
    assert.equal(readOwnerPrivateFileSync(file, "utf8", options), "{\"token\":\"t2\"}");
    // The file's owner, DACL and bytes through one handle, then (its entries are inherited) its folders once.
    assert.equal(reads.length - before, 2);
    assert.equal(reads.at(-2), `object:${file}`);
    assert.ok(reads.at(-1)!.startsWith(`${folder}|`), reads.at(-1));
    before = reads.length;
    for (let index = 0; index < 100; index += 1) readOwnerPrivateFileSync(file, "utf8", options);
    for (let index = 0; index < 20; index += 1) await readOwnerPrivateFile(file, "utf8", options);
    assert.equal(reads.length, before, "an unchanged secret is read without a new check");
    assert.deepEqual(calls, [], "no protect (icacls) on any read");
  } finally { forgetOwnerPrivateCache(); rmSync(root, { recursive: true, force: true }); }
});

test("Windows: a grant added to a checked secret moves its change time, and the next read refuses it, names it, and leaves it as it is", async () => {
  const root = scratch();
  try {
    const folder = join(root, "state");
    mkdirSync(folder);
    const file = join(folder, "token.json");
    writeFileSync(file, "secret");
    const { security, calls, sddl } = fakeSecurity({ [folder]: PRIVATE_FOLDER, [file]: INHERITED_PRIVATE });
    const options = { platform: "win32" as const, windowsSecurity: security };
    touch(file, 1_000);
    assert.equal(readOwnerPrivateFileSync(file, "utf8", options), "secret");
    // `icacls token.json /grant Everyone:R`: an explicit entry, and NTFS moves the change time.
    const widened = `O:${USER}D:AI(A;;FR;;;WD)(A;ID;FA;;;SY)(A;ID;FA;;;${USER})`;
    sddl[file] = widened;
    touch(file, 2_000);
    assert.throws(() => readOwnerPrivateFileSync(file, "utf8", options), (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "EOWNERPRIVATE");
      assert.ok(error.message.includes(file), error.message);
      return true;
    });
    await assert.rejects(readOwnerPrivateFile(file, "utf8", options), { code: "EOWNERPRIVATE" });
    // Never repaired: no protect ran, and the next read refuses it again.
    assert.deepEqual(calls, []);
    assert.equal(sddl[file], widened);
    assert.throws(() => readOwnerPrivateFileSync(file, "utf8", options), { code: "EOWNERPRIVATE" });
  } finally { forgetOwnerPrivateCache(); rmSync(root, { recursive: true, force: true }); }
});

test("Windows: a secret another account owns is refused and never taken over, even in a private folder", async () => {
  const root = scratch();
  try {
    const folder = join(root, "state");
    mkdirSync(folder);
    const file = join(folder, "token.json");
    writeFileSync(file, "planted");
    const foreign = `O:${OTHER}D:PAI(A;;FA;;;SY)(A;;FA;;;${OTHER})(A;;FA;;;${USER})`;
    const { security, calls, sddl } = fakeSecurity({ [folder]: PRIVATE_FOLDER, [file]: foreign });
    const options = { platform: "win32" as const, windowsSecurity: security };
    assert.throws(() => readOwnerPrivateFileSync(file, "utf8", options), { code: "EOWNERPRIVATE" });
    await assert.rejects(readOwnerPrivateFile(file, "utf8", options), { code: "EOWNERPRIVATE" });
    assert.deepEqual(calls, []);
    assert.equal(sddl[file], foreign);
    // A link is never followed to a secret.
    const target = join(folder, "target");
    writeFileSync(target, "x");
    const linked = join(folder, "linked");
    symlinkSync(target, linked);
    // A link is a refusal (never "no file", which a caller could read as empty state and overwrite).
    assert.throws(() => readOwnerPrivateFileSync(linked, "utf8", options), (error: NodeJS.ErrnoException) => error.code === "EOWNERPRIVATE" && (error.cause as NodeJS.ErrnoException)?.code === "ELOOP");
    await assert.rejects(readOwnerPrivateFile(linked, "utf8", options), { code: "EOWNERPRIVATE" });
    assert.throws(() => readOwnerPrivateFileSync(join(folder, "missing"), "utf8", options), { code: "ENOENT" });
    // No upgrade for another account's file.
    assert.throws(() => readOwnerPrivateFileSync(file, "utf8", { ...options, upgradeAdministratorsOnly: true }), { code: "EOWNERPRIVATE" });
    assert.deepEqual(calls, []);
  } finally { forgetOwnerPrivateCache(); rmSync(root, { recursive: true, force: true }); }
});

test("Windows: a secret another process replaces during the check is opened again and read whole", async () => {
  const root = scratch();
  try {
    const folder = join(root, "state");
    mkdirSync(folder);
    const file = join(folder, "token.json");
    writeFileSync(file, "old");
    const { security, sddl } = fakeSecurity({ [folder]: PRIVATE_FOLDER, [file]: INHERITED_PRIVATE });
    let swaps = 0;
    const swapping: WindowsSecurity = {
      ...security,
      readObjectsSync(paths) {
        if (swaps === 0) { swaps += 1; writeFileSync(`${file}.new`, "new"); renameSync(`${file}.new`, file); }
        return security.readObjectsSync!(paths);
      },
    };
    const options = { platform: "win32" as const, windowsSecurity: swapping };
    assert.equal(readOwnerPrivateFileSync(file, "utf8", options), "new");
    assert.equal(swaps, 1);
    // A path that is replaced on every check gives up after a few tries and refuses it.
    const always: WindowsSecurity = {
      ...security,
      readObjectsSync(paths) { writeFileSync(`${file}.new`, "again"); renameSync(`${file}.new`, file); return security.readObjectsSync!(paths); },
    };
    sddl[file] = INHERITED_PRIVATE;
    forgetOwnerPrivateCache();
    assert.throws(() => readOwnerPrivateFileSync(file, "utf8", { platform: "win32", windowsSecurity: always }), { code: "EOWNERPRIVATE" });
  } finally { forgetOwnerPrivateCache(); rmSync(root, { recursive: true, force: true }); }
});

test("Windows: a state folder is made private only from Administrators-only access; any other folder is left as it is", () => {
  const root = scratch();
  try {
    const folder = join(root, ".letagents");
    mkdirSync(folder);
    const { security, calls, sddl } = fakeSecurity({ [folder]: `O:BAD:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})` });
    // As icacls: the protect replaces the folder's DACL.
    const protecting: WindowsSecurity = { ...security, protectSync(path, kind) { security.protectSync(path, kind); sddl[path] = PRIVATE_FOLDER; } };
    const options = { platform: "win32" as const, windowsSecurity: protecting };
    assert.equal(ensurePrivateStateFolderSync(folder, options), true);
    assert.deepEqual(calls, [`protect:directory:${folder}`]);
    forgetOwnerPrivateCache();
    assert.equal(ensurePrivateStateFolderSync(folder, options), true);
    assert.equal(calls.length, 1, "a private folder is only read");
    assert.equal(ensurePrivateStateFolderSync(join(root, "missing"), options), false);
    // A grant to another account (Users, Everyone) or another owner: left as it is, nothing exposed is made to look private.
    for (const [name, folderSddl] of [
      ["users", `O:${USER}D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;${USER})(A;OICIID;0x1301bf;;;BU)`],
      ["everyone", `O:${USER}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})(A;OICI;FR;;;WD)`],
      ["foreign", `O:${OTHER}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;${OTHER})`],
    ] as const) {
      const other = join(root, name);
      mkdirSync(other);
      sddl[other] = folderSddl;
      assert.equal(ensurePrivateStateFolderSync(other, options), false, name);
    }
    assert.equal(calls.length, 1);
    assert.equal(ensurePrivateStateFolderSync(folder, { windowsSecurity: protecting }), process.platform === "win32");
  } finally { forgetOwnerPrivateCache(); rmSync(root, { recursive: true, force: true }); }
});

test("Windows: an Administrators-only secret (an older version's state) is made private by itself and read; a wider one is not", async () => {
  const root = scratch();
  try {
    const folder = join(root, "state");
    mkdirSync(folder);
    const legacy = join(folder, "legacy.json");
    const shared = join(folder, "shared.json");
    writeFileSync(legacy, "legacy");
    writeFileSync(shared, "shared");
    const { security, calls, sddl } = fakeSecurity({
      [folder]: `O:${USER}D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`,
      [legacy]: `O:BAD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${USER})`,
      [shared]: `O:${USER}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;${USER})(A;ID;0x1200a9;;;BU)`,
    });
    const options = { platform: "win32" as const, windowsSecurity: security };
    // Without the option nothing is changed.
    assert.throws(() => readOwnerPrivateFileSync(legacy, "utf8", options), { code: "EOWNERPRIVATE" });
    assert.deepEqual(calls, []);
    assert.equal(readOwnerPrivateFileSync(legacy, "utf8", { ...options, upgradeAdministratorsOnly: true }), "legacy");
    assert.deepEqual(calls, [`upgrade:${legacy}`], "the file only, through one handle; its folder is not changed");
    assert.throws(() => readOwnerPrivateFileSync(shared, "utf8", { ...options, upgradeAdministratorsOnly: true }), { code: "EOWNERPRIVATE" });
    await assert.rejects(readOwnerPrivateFile(shared, "utf8", { ...options, upgradeAdministratorsOnly: true }), { code: "EOWNERPRIVATE" });
    assert.equal(calls.length, 1, "a file other accounts could open is never made to look private");
    assert.match(sddl[shared]!, /;;;BU\)$/);
  } finally { forgetOwnerPrivateCache(); rmSync(root, { recursive: true, force: true }); }
});

test("Windows: an upgrade judges the file it opens: one swapped in or widened before it is refused, untouched", () => {
  const root = scratch();
  try {
    const folder = join(root, "state");
    mkdirSync(folder);
    const legacy = join(folder, "legacy.json");
    writeFileSync(legacy, "legacy");
    const adminOnly = `O:${USER}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${USER})`;
    const exposed = `O:${USER}D:AI(A;;FR;;;WD)(A;ID;FA;;;SY)(A;ID;FA;;;${USER})`;
    const { security, calls, sddl } = fakeSecurity({ [folder]: `O:${USER}D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`, [legacy]: adminOnly });
    // After the check, before the upgrade opens it: an exposed file (this account's) takes the path.
    const swapping: WindowsSecurity = {
      ...security,
      upgradeObjectSync(path) { writeFileSync(`${legacy}.new`, "planted"); renameSync(`${legacy}.new`, legacy); sddl[legacy] = exposed; return security.upgradeObjectSync!(path); },
    };
    const options = { platform: "win32" as const, upgradeAdministratorsOnly: true };
    assert.throws(() => readOwnerPrivateFileSync(legacy, "utf8", { ...options, windowsSecurity: swapping }), { code: "EOWNERPRIVATE" });
    assert.deepEqual(calls, [], "nothing was made private");
    assert.equal(sddl[legacy], exposed);
    // The same file, widened just before the upgrade: refused too.
    forgetOwnerPrivateCache();
    writeFileSync(legacy, "legacy 2");
    sddl[legacy] = adminOnly;
    const widening: WindowsSecurity = { ...security, upgradeObjectSync(path) { sddl[legacy] = exposed; return security.upgradeObjectSync!(path); } };
    assert.throws(() => readOwnerPrivateFileSync(legacy, "utf8", { ...options, windowsSecurity: widening }), { code: "EOWNERPRIVATE" });
    assert.deepEqual(calls, []);
  } finally { forgetOwnerPrivateCache(); rmSync(root, { recursive: true, force: true }); }
});

test("Windows: the bytes returned are the ones whose owner and DACL were checked; a later file with other bytes is checked again", () => {
  const root = scratch();
  try {
    const folder = join(root, "state");
    mkdirSync(folder);
    const file = join(folder, "token.json");
    writeFileSync(file, "checked");
    const { security, reads, sddl } = fakeSecurity({ [folder]: PRIVATE_FOLDER, [file]: INHERITED_PRIVATE });
    // A rename above the file during the check points the handle at another (private) file: the bytes
    // returned are that file's, never the planted one's, and the verdict holds only for those bytes.
    let planted = false;
    const elsewhere: WindowsSecurity = {
      ...security,
      readObjectsSync(paths) { return planted ? security.readObjectsSync!(paths) : paths.map(() => ({ sddl: PRIVATE_FILE, data: Buffer.from(other) })); },
    };
    const options = { platform: "win32" as const, windowsSecurity: elsewhere };
    // Bytes of another length than the file seen around the check are never accepted.
    let other = "our other file";
    assert.throws(() => readOwnerPrivateFileSync(file, "utf8", options), { code: "EOWNERPRIVATE" });
    other = "otherss";
    assert.equal(readOwnerPrivateFileSync(file, "utf8", options), "otherss");
    // Node's own handle then reads the path's real bytes ("checked"): they are not the bytes checked, so it is checked again.
    planted = true;
    sddl[file] = `O:${OTHER}D:PAI(A;;FA;;;${OTHER})(A;;FA;;;${USER})`;
    const before = reads.length;
    assert.throws(() => readOwnerPrivateFileSync(file, "utf8", options), { code: "EOWNERPRIVATE" });
    assert.equal(reads.length - before, 1);
  } finally { forgetOwnerPrivateCache(); rmSync(root, { recursive: true, force: true }); }
});

test("Windows: a secret's verdict lasts five minutes at most, even when nothing about the file changed", (t) => {
  const root = scratch();
  try {
    const folder = join(root, "state");
    mkdirSync(folder);
    const file = join(folder, "token.json");
    writeFileSync(file, "secret");
    const { security, reads, sddl } = fakeSecurity({ [folder]: PRIVATE_FOLDER, [file]: INHERITED_PRIVATE });
    const options = { platform: "win32" as const, windowsSecurity: security };
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    assert.equal(readOwnerPrivateFileSync(file, "utf8", options), "secret");
    const before = reads.length;
    t.mock.timers.tick(4 * 60_000);
    assert.equal(readOwnerPrivateFileSync(file, "utf8", options), "secret");
    assert.equal(reads.length, before);
    // A grant whose change time was set back: seen once the verdict runs out.
    sddl[file] = `O:${USER}D:AI(A;;FR;;;WD)(A;ID;FA;;;SY)(A;ID;FA;;;${USER})`;
    t.mock.timers.tick(60_000 + 1);
    assert.throws(() => readOwnerPrivateFileSync(file, "utf8", options), { code: "EOWNERPRIVATE" });
  } finally { forgetOwnerPrivateCache(); rmSync(root, { recursive: true, force: true }); }
});

test("synchronous reads wait for one long-lived reader in a worker thread; a reader that stops or hangs is given up", () => {
  const answering = "require('readline').createInterface({ input: process.stdin }).on('line', (line) => "
    + "console.log(line === '' ? 'done:' : line.endsWith('missing') ? 'error:' : 'ok:' + line));";
  const reader = createSyncSddlServer(syncSddlReaderWorker(process.execPath, ["-e", answering]));
  try {
    // prepare() starts the reader without waiting; the first read takes its answer first.
    reader.prepare();
    reader.prepare();
    assert.deepEqual(reader.read(["C:\\a", "C:\\b missing"]), ["C:\\a", null]);
    const started = performance.now();
    for (let index = 0; index < 50; index += 1) assert.deepEqual(reader.read([`C:\\${index}`]), [`C:\\${index}`]);
    console.log(`sync reader: ${((performance.now() - started) / 50).toFixed(2)} ms per read`);
    assert.throws(() => reader.read(["C:\\Users\\José\\x"]), { code: "EOWNERPRIVATE" });
    assert.equal(reader.usable, true, "a path the reader does not take leaves it usable");
  } finally { reader.stop(); }
  const stopped = createSyncSddlServer(syncSddlReaderWorker(process.execPath, ["-e", "process.exit(3)"]));
  assert.throws(() => stopped.read(["C:\\a"]), { code: "EOWNERPRIVATE" });
  assert.equal(stopped.usable, false);
  const hung = createSyncSddlServer(syncSddlReaderWorker(process.execPath, ["-e", "process.stdin.resume()"]), { timeoutMs: 300, startTimeoutMs: 300 });
  assert.throws(() => hung.read(["C:\\a"]), { code: "EOWNERPRIVATE" });
  assert.equal(hung.usable, false);
  const short = createSyncSddlServer(syncSddlReaderWorker(process.execPath, ["-e", "require('readline').createInterface({ input: process.stdin }).on('line', (l) => { if (l === '') console.log('done:'); });"]));
  assert.throws(() => short.read(["C:\\a"]), { code: "EOWNERPRIVATE" });
  assert.equal(short.usable, false);
});

test("Windows: synchronous reads use the long-lived reader, and fall back to one-shot PowerShell when it fails", () => {
  const oneShot: string[] = [];
  const runSync = (_file: string, _args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
    const paths = options.env.LETAGENTS_OWNER_PRIVATE_PATHS!.split("\n");
    oneShot.push(...paths);
    return paths.map(() => `ok:${PRIVATE_FILE}`).join("\n");
  };
  const answering = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => console.log(line === '' ? 'done:' : 'ok:${PRIVATE_FILE}'));`;
  const security = createWindowsSecurity({ env: { SystemRoot: "C:\\Windows" }, runSync, startSyncServer: syncSddlReaderWorker(process.execPath, ["-e", answering]) });
  assert.deepEqual(security.readSddlSync(["C:\\a", "C:\\b"]), [PRIVATE_FILE, PRIVATE_FILE]);
  assert.deepEqual(oneShot, []);
  assert.deepEqual(security.readSddlSync(["C:\\Users\\José\\x"]), [PRIVATE_FILE]);
  assert.deepEqual(oneShot, ["C:\\Users\\José\\x"]);
  // A reader that never answers is not started again: its start does not work here.
  let starts = 0;
  const exiting = syncSddlReaderWorker(process.execPath, ["-e", "process.exit(1)"]);
  const failing = createWindowsSecurity({ env: { SystemRoot: "C:\\Windows" }, runSync, startSyncServer: (channel) => { starts += 1; return exiting(channel); } });
  for (const name of ["c", "d", "e"]) {
    assert.deepEqual(failing.readSddlSync([`C:\\${name}`]), [PRIVATE_FILE]);
    assert.deepEqual(oneShot.at(-1), `C:\\${name}`);
  }
  assert.equal(starts, 1);
  // One that answered and then stopped is started again (and warmed), twice at most; then every read is one-shot.
  const twice = `let done = 0; require('readline').createInterface({ input: process.stdin }).on('line', (line) => { if (line !== '') return console.log('ok:${PRIVATE_FILE}'); if (++done === 2) process.stdout.write('done:\\n', () => process.exit(0)); else console.log('done:'); });`;
  let restarted = 0;
  const flaky = syncSddlReaderWorker(process.execPath, ["-e", twice]);
  const recovering = createWindowsSecurity({ env: { SystemRoot: "C:\\Windows" }, runSync, startSyncServer: (channel) => { restarted += 1; return flaky(channel); } });
  for (let index = 0; index < 10; index += 1) assert.deepEqual(recovering.readSddlSync([`C:\\r${index}`]), [PRIVATE_FILE]);
  assert.equal(restarted, 3);
  // Injected runners get no reader unless the test asks for one.
  const plain = createWindowsSecurity({ env: { SystemRoot: "C:\\Windows" }, runSync });
  assert.deepEqual(plain.readSddlSync(["C:\\g"]), [PRIVATE_FILE]);
  assert.deepEqual(oneShot.at(-1), "C:\\g");
});

function icacls(...args: string[]): void {
  execFileSync(windowsSystemTool("icacls.exe"), args, { stdio: "ignore", windowsHide: true });
}

test("real Windows: private folders and files pass, and every tampered ACL is refused", { skip: windowsOnly }, async () => {
  const root = scratch();
  try {
    const security = createWindowsSecurity();
    const folder = join(root, "state");
    await createPrivateDir(folder);
    const [sddl] = await security.readSddl([folder]);
    console.log(`private folder SDDL: ${sddl}`);
    assert.ok(sddlIsOwnerPrivate(sddl, { sid: await security.currentUserSid(), aliases: await security.currentUserAliases!() }));
    await assertOwnerPrivate(folder, { kind: "directory" });
    const file = join(folder, "token.json");
    await writePrivateFileAtomically(file, "{\"token\":\"t\"}");
    await assertOwnerPrivate(file);
    assertOwnerPrivateSync(file, { exactMode: 0o600 });
    assert.equal(await isOwnedByCurrentUser(file, lstatSync(file)), true);

    // A plain write inside the private folder inherits only its private entries.
    const child = join(folder, "child.txt");
    writeFileSync(child, "c");
    const [childSddl] = await security.readSddl([child]);
    console.log(`inherited file SDDL: ${childSddl}`);
    assert.ok(sddlHasPrivateEntries(childSddl, { sid: await security.currentUserSid(), aliases: await security.currentUserAliases!() }));
    assert.equal(await isOwnerPrivate(child, lstatSync(child)), true);
    // A cold process (no verified folders) reaches the same answer in one read.
    forgetOwnerPrivateCache();
    assert.equal(await isOwnerPrivate(child, lstatSync(child)), true);

    // Tamper, cold: an explicit Everyone (S-1-1-0) entry on a file.
    forgetOwnerPrivateCache();
    icacls(file, "/grant", "*S-1-1-0:R");
    await assert.rejects(assertOwnerPrivate(file), { code: "EOWNERPRIVATE" });
    // Tamper: Users (S-1-5-32-545) on the folder, inheritable; the folder and what it holds are refused.
    forgetOwnerPrivateCache();
    icacls(folder, "/grant", "*S-1-5-32-545:(OI)(CI)R");
    await assert.rejects(assertOwnerPrivate(folder, { kind: "directory" }), { code: "EOWNERPRIVATE" });
    assert.equal(await isOwnerPrivate(child, lstatSync(child)), false);
    // Tamper: inheritance switched back on for a private folder in the (not private) temp folder.
    const second = join(root, "second");
    await createPrivateDir(second);
    forgetOwnerPrivateCache();
    icacls(second, "/inheritance:e");
    await assert.rejects(assertOwnerPrivate(second, { kind: "directory" }), { code: "EOWNERPRIVATE" });
    // A plain file in the temp folder (inherited ACL) is not private.
    const plain = join(root, "plain.txt");
    writeFileSync(plain, "p");
    assert.equal(isOwnerPrivateSync(plain, lstatSync(plain)), false);
  } finally {
    forgetOwnerPrivateCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("real Windows: the long-lived reader answers later reads without a new PowerShell start", { skip: windowsOnly }, async () => {
  const root = scratch();
  try {
    const security = createWindowsSecurity();
    let started = performance.now();
    const first = await security.readSddl([root]);
    const firstMs = performance.now() - started;
    started = performance.now();
    for (let index = 0; index < 20; index += 1) assert.match(String((await security.readSddl([root, tmpdir()]))[1]), /^O:/);
    const laterMs = (performance.now() - started) / 20;
    console.log(`reader: first read ${Math.round(firstMs)} ms, later reads ${Math.round(laterMs)} ms each`);
    assert.match(String(first[0]), /^O:/);
    assert.ok(laterMs < firstMs, `later reads (${Math.round(laterMs)} ms) are not faster than the first (${Math.round(firstMs)} ms)`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real Windows: one PowerShell call reads several paths, one answer per path", { skip: windowsOnly }, async () => {
  const root = scratch();
  try {
    const security = createWindowsSecurity();
    const paths = [root, join(root, "missing"), tmpdir(), join(root, "a b")];
    mkdirSync(paths[3]!);
    const answers = await security.readSddl(paths);
    assert.equal(answers.length, 4);
    assert.match(String(answers[0]), /^O:/);
    assert.equal(answers[1], null);
    assert.match(String(answers[2]), /^O:/);
    assert.match(String(answers[3]), /^O:/);
    assert.deepEqual(security.readSddlSync(paths).map(answer => answer === null), [false, true, false, false]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real Windows: protecting a folder also narrows what a file already in it inherits", { skip: windowsOnly }, async () => {
  const root = scratch();
  try {
    const security = createWindowsSecurity();
    const folder = join(root, "existing");
    mkdirSync(folder);
    const file = join(folder, "old.json");
    writeFileSync(file, "{}");
    const [before] = await security.readSddl([file]);
    console.log(`before: ${before}`);
    await protectOwnerPrivate(folder, "directory");
    const [after] = await security.readSddl([file]);
    console.log(`after: ${after}`);
    assert.ok(sddlHasPrivateEntries(after, { sid: await security.currentUserSid(), aliases: await security.currentUserAliases!() }));
    forgetOwnerPrivateCache();
    assert.equal(await isOwnerPrivate(file, lstatSync(file)), true);
  } finally { forgetOwnerPrivateCache(); rmSync(root, { recursive: true, force: true }); }
});

test("real Windows: a recursive private mkdir never changes a folder that already existed", { skip: windowsOnly }, async () => {
  const root = scratch();
  try {
    const security = createWindowsSecurity();
    const [before] = await security.readSddl([root]);
    await createPrivateDir(join(root, "a", "b"), { recursive: true });
    const [after] = await security.readSddl([root]);
    assert.equal(after, before);
    await assertOwnerPrivate(join(root, "a"), { kind: "directory" });
    await assertOwnerPrivate(join(root, "a", "b"), { kind: "directory" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real Windows: openNoFollow refuses a junction and a file symlink target is never followed", { skip: windowsOnly }, async () => {
  const root = scratch();
  try {
    const target = join(root, "target");
    mkdirSync(target);
    writeFileSync(join(target, "file"), "x");
    symlinkSync(target, join(root, "junction"), "junction");
    assert.equal(lstatSync(join(root, "junction")).isSymbolicLink(), true);
    await assert.rejects(openNoFollow(join(root, "junction"), constants.O_RDONLY), { code: "ELOOP" });
    assert.throws(() => openNoFollowSync(join(root, "junction"), constants.O_RDONLY), { code: "ELOOP" });
    const handle = await openNoFollow(join(target, "file"), constants.O_RDONLY);
    await handle.close();
    // fsync of a folder is skipped on Windows; it must not throw.
    await syncDirectory(target);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real Windows: costs: one protect, one cold check, and many writes in a private folder", { skip: windowsOnly }, async () => {
  const root = scratch();
  try {
    forgetOwnerPrivateCache();
    const folder = join(root, "timed");
    let started = performance.now();
    await createPrivateDir(folder);
    const protectMs = performance.now() - started;
    forgetOwnerPrivateCache();
    const file = join(folder, "timed.json");
    writeFileSync(file, "{}");
    started = performance.now();
    await assertOwnerPrivate(file);
    const coldCheckMs = performance.now() - started;
    // Count every tool the helper starts during the writes: none may start.
    const real = createWindowsSecurity();
    let tools = 0;
    const counted = new Proxy(real, {
      get(target, name, receiver) {
        const value = Reflect.get(target, name, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (!/^currentUser/.test(String(name))) tools += 1;
          return value.apply(target, args);
        };
      },
    });
    const options = { windowsSecurity: counted as WindowsSecurity };
    await assertOwnerPrivate(folder, { ...options, kind: "directory" });
    tools = 0;
    started = performance.now();
    for (let index = 0; index < 100; index += 1) {
      await writePrivateFileAtomically(join(folder, `w${index % 5}.json`), String(index), options);
      await protectOwnerPrivate(join(folder, `w${index % 5}.json`), "file", options);
      await assertOwnerPrivate(join(folder, `w${index % 5}.json`), options);
    }
    const hundredMs = performance.now() - started;
    console.log(`owner-private costs: protect folder ${Math.round(protectMs)} ms, cold check ${Math.round(coldCheckMs)} ms, 100 x (write + protect + check) in a private folder ${Math.round(hundredMs)} ms, tools started ${tools}`);
    assert.ok(protectMs < 15_000 && coldCheckMs < 15_000);
    assert.equal(tools, 0);
  } finally { forgetOwnerPrivateCache(); rmSync(root, { recursive: true, force: true }); }
});

test("real Windows: synchronous reads go to a long-lived reader; later reads cost milliseconds, not a PowerShell start", { skip: windowsOnly }, () => {
  const root = scratch();
  try {
    const security = createWindowsSecurity();
    let started = performance.now();
    const first = security.readSddlSync([root]);
    const firstMs = performance.now() - started;
    started = performance.now();
    for (let index = 0; index < 20; index += 1) assert.match(String(security.readSddlSync([root, tmpdir()])[1]), /^O:/);
    const laterMs = (performance.now() - started) / 20;
    console.log(`sync reader: first read ${Math.round(firstMs)} ms, later reads ${laterMs.toFixed(1)} ms each`);
    assert.match(String(first[0]), /^O:/);
    assert.ok(laterMs < firstMs && laterMs < 250, `later sync reads (${laterMs.toFixed(1)} ms) are not fast`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A real WindowsSecurity that counts every tool use (whoami lookups aside), by method. */
function countingSecurity() {
  const real = createWindowsSecurity();
  const counts: Record<string, number> = {};
  const security = new Proxy(real, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (!/^currentUser/.test(String(name))) counts[String(name)] = (counts[String(name)] ?? 0) + 1;
        return value.apply(target, args);
      };
    },
  }) as WindowsSecurity;
  return { security, counts, total: () => Object.values(counts).reduce((sum, count) => sum + count, 0) };
}

test("real Windows: a fresh token passes; an Everyone grant and another owner are refused and left as they are; reads cost no tool", { skip: windowsOnly }, async () => {
  const root = scratch();
  try {
    forgetOwnerPrivateCache();
    const folder = join(root, "state");
    await createPrivateDir(folder);
    const writer = countingSecurity();
    const writerOptions = { windowsSecurity: writer.security };
    const token = join(folder, "mcp-state.json");
    // What a rename changes on this host (logged for the record; the writer does not compare the change time).
    const probe = join(folder, "probe.tmp");
    writeFileSync(probe, "probe");
    const probeBefore = lstatSync(probe, { bigint: true });
    renameSync(probe, join(folder, "probe.json"));
    const probeAfter = lstatSync(join(folder, "probe.json"), { bigint: true });
    console.log(`rename keeps: ino ${probeBefore.ino === probeAfter.ino}, ctime ${probeBefore.ctimeNs === probeAfter.ctimeNs}, mtime ${probeBefore.mtimeNs === probeAfter.mtimeNs}`);
    writePrivateFileAtomicallySync(token, "{\"token\":\"fresh\"}", writerOptions);

    // The writer reads its own fresh token back with no icacls, and at most one warm DACL read (none when the
    // rename kept the change time).
    const before = { ...writer.counts };
    assert.equal(readOwnerPrivateFileSync(token, "utf8", writerOptions), "{\"token\":\"fresh\"}");
    assert.equal(writer.counts.protectSync ?? 0, before.protectSync ?? 0, `the writer's read ran icacls: ${JSON.stringify(writer.counts)}`);
    assert.ok((writer.counts.readObjectsSync ?? 0) - (before.readObjectsSync ?? 0) <= 1, JSON.stringify(writer.counts));

    // Another process (a cold WindowsSecurity): one DACL read on the first read, none after; never a protect.
    const reader = countingSecurity();
    const readerOptions = { windowsSecurity: reader.security };
    let started = performance.now();
    assert.equal(readOwnerPrivateFileSync(token, "utf8", readerOptions), "{\"token\":\"fresh\"}");
    const coldMs = performance.now() - started;
    const afterCold = { ...reader.counts };
    started = performance.now();
    for (let index = 0; index < 200; index += 1) readOwnerPrivateFileSync(token, "utf8", readerOptions);
    const unchangedMs = (performance.now() - started) / 200;
    assert.deepEqual(reader.counts, afterCold, "an unchanged token is read without a tool");
    // The writer saves again (a new file): the reader checks the new file's own DACL once, through the warm reader.
    const timings: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      writePrivateFileAtomicallySync(token, `{"token":"t${index}"}`, writerOptions);
      started = performance.now();
      assert.equal(readOwnerPrivateFileSync(token, "utf8", readerOptions), `{"token":"t${index}"}`);
      timings.push(performance.now() - started);
    }
    const changedMs = timings.reduce((sum, ms) => sum + ms, 0) / timings.length;
    console.log(`secret reads: cold ${Math.round(coldMs)} ms, unchanged ${unchangedMs.toFixed(3)} ms, after another process saved it ${changedMs.toFixed(1)} ms; reader tools ${JSON.stringify(reader.counts)}`);
    assert.equal(reader.counts.protectSync ?? 0, 0, "no icacls on any read");
    assert.equal(reader.counts.protect ?? 0, 0, "no icacls on any read");
    assert.equal(reader.counts.readObjectsSync, 1 + 20, "one handle read per new file, none for an unchanged one");
    assert.ok(changedMs < 250, `a check after another process saved the file took ${changedMs.toFixed(1)} ms`);

    // icacls token /grant Everyone:R: the same process refuses it at the next read (the change time moved).
    icacls(token, "/grant", "*S-1-1-0:R");
    assert.throws(() => readOwnerPrivateFileSync(token, "utf8", readerOptions), (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "EOWNERPRIVATE");
      assert.ok(error.message.includes(token), error.message);
      return true;
    });
    await assert.rejects(readOwnerPrivateFile(token, "utf8", writerOptions), { code: "EOWNERPRIVATE" });
    const [widened] = await createWindowsSecurity().readSddl([token]);
    assert.match(String(widened), /;;;WD\)/, "the grant is left as it is: nothing is repaired");

    // Another owner (SYSTEM): refused, and not taken over.
    const planted = join(folder, "planted.json");
    writePrivateFileAtomicallySync(planted, "{\"token\":\"planted\"}");
    let ownerChanged = true;
    try { icacls(planted, "/setowner", "*S-1-5-18"); } catch { ownerChanged = false; }
    if (!ownerChanged) {
      console.log("this runner cannot give a file to SYSTEM; the fake owner test covers another owner");
    } else {
      forgetOwnerPrivateCache();
      assert.throws(() => readOwnerPrivateFileSync(planted, "utf8"), { code: "EOWNERPRIVATE" });
      await assert.rejects(readOwnerPrivateFile(planted, "utf8"), { code: "EOWNERPRIVATE" });
      const [owned] = await createWindowsSecurity().readSddl([planted]);
      assert.match(String(owned), /^O:(SY|S-1-5-18)/, `the owner was changed: ${owned}`);
    }
  } finally { forgetOwnerPrivateCache(); rmSync(root, { recursive: true, force: true }); }
});

test("real Windows: an older version's Administrators-only state is made private through one handle; a wider one is left as it is", { skip: windowsOnly }, () => {
  const root = scratch();
  try {
    forgetOwnerPrivateCache();
    const security = createWindowsSecurity();
    const user = { sid: security.currentUserSidSync(), aliases: security.currentUserAliasesSync!() };
    // A plain file in the temporary folder has a profile folder's access (this account, SYSTEM, Administrators).
    const legacy = join(root, "mcp-state.json");
    writeFileSync(legacy, "{\"auth\":{\"token\":\"t\"}}");
    const [before] = security.readSddlSync([legacy]);
    console.log(`older version's state SDDL: ${before}`);
    if (!sddlHasOnlyAdministratorAccess(before, user)) {
      console.log("this runner's temporary folder grants more than Administrators; the fake upgrade tests cover it");
      return;
    }
    assert.throws(() => readOwnerPrivateFileSync(legacy, "utf8"), { code: "EOWNERPRIVATE" });
    assert.equal(readOwnerPrivateFileSync(legacy, "utf8", { upgradeAdministratorsOnly: true }), "{\"auth\":{\"token\":\"t\"}}");
    const [after] = security.readSddlSync([legacy]);
    console.log(`upgraded SDDL: ${after}`);
    assert.ok(sddlIsOwnerPrivate(after, user), String(after));
    // A file that Everyone may read is not upgraded, and its DACL is left as it was.
    const shared = join(root, "shared.json");
    writeFileSync(shared, "{}");
    icacls(shared, "/grant", "*S-1-1-0:R");
    const [widened] = security.readSddlSync([shared]);
    assert.throws(() => readOwnerPrivateFileSync(shared, "utf8", { upgradeAdministratorsOnly: true }), { code: "EOWNERPRIVATE" });
    assert.equal(security.readSddlSync([shared])[0], widened);
  } finally { forgetOwnerPrivateCache(); rmSync(root, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  assertOwnerPrivate,
  assertOwnerPrivateSync,
  createPrivateDir,
  createPrivateDirSync,
  createWindowsSecurity,
  everyOwnedByCurrentUserSync,
  everyOwnerPrivateSync,
  forgetOwnerPrivateCache,
  icaclsProtectArguments,
  icaclsRemoveArguments,
  icaclsSaveArguments,
  parseIcaclsSave,
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
  parseWhoamiUserSid,
  protectOwnerPrivate,
  protectOwnerPrivateSync,
  sddlExtraGrantSids,
  sddlHasProfileDefaultAccess,
  sddlHasPrivateEntries,
  sddlIsOwnerPrivate,
  userSidAliases,
  syncDirectory,
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
  const protect = (path: string, kind: string) => { calls.push(`protect:${kind}:${path}`); if (!(path in sddl)) sddl[path] = PRIVATE_FILE; };
  const security: WindowsSecurity = {
    async currentUserSid() { return sid; },
    currentUserSidSync() { return sid; },
    async readSddl(paths) { return read(paths); },
    readSddlSync(paths) { return read(paths); },
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
      const paths = JSON.parse(options.env.LETAGENTS_OWNER_PRIVATE_PATHS!) as string[];
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
  assert.match(String(powershell.args[4]), /Get-Acl -LiteralPath \$p/);
  assert.match(String(powershell.args[4]), /\$env:LETAGENTS_OWNER_PRIVATE_PATHS/);
  // The paths travel as JSON in the environment, never in the command text.
  assert.equal(powershell.paths, JSON.stringify(["C:\\a", "C:\\b missing"]));
  assert.ok(!String(powershell.args[4]).includes("C:\\a"));
  // Owner first (an elevated administrator's files are owned by Administrators), then the DACL.
  assert.deepEqual(calls.filter(call => call.file.endsWith("icacls.exe")).map(call => [call.file, call.args]), [
    ["C:\\Windows\\System32\\icacls.exe", ["C:\\a", "/setowner", `*${USER}`, "/q"]],
    ["C:\\Windows\\System32\\icacls.exe", ["C:\\a", "/inheritance:r", "/remove:g", ...REMOVED, "/grant:r", `*${USER}:F`, "*S-1-5-18:F", "/q"]],
    ["C:\\Windows\\System32\\icacls.exe", ["C:\\d", "/setowner", `*${USER}`, "/q"]],
    ["C:\\Windows\\System32\\icacls.exe", ["C:\\d", "/inheritance:r", "/remove:g", ...REMOVED, "/grant:r", `*${USER}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/q"]],
  ]);
});

test("icacls /save is parsed from UTF-16LE, skipping a name line that starts with a drive", () => {
  const text = "D:\\a\\letagents\\state\r\nD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-1-2-3-500)\r\n";
  assert.equal(parseIcaclsSave(Buffer.from(text, "utf16le")), "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-1-2-3-500)");
  assert.equal(parseIcaclsSave(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])), "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-1-2-3-500)");
  assert.equal(parseIcaclsSave(Buffer.from(text, "utf8")), "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-1-2-3-500)");
  assert.throws(() => parseIcaclsSave(Buffer.from("D:\\only-a-name\r\n", "utf16le")), { code: "EOWNERPRIVATE" });
  assert.deepEqual(icaclsSaveArguments("C:\\a", "C:\\t\\acl.txt"), ["C:\\a", "/save", "C:\\t\\acl.txt", "/q"]);
});

test("Windows: a protect is icacls only (owner, DACL, /save read-back); nothing runs again below it", async () => {
  const root = scratch();
  try {
    const folder = join(root, "state");
    mkdirSync(folder);
    const calls: string[][] = [];
    const runner = (file: string, args: readonly string[]) => {
      calls.push([file.split("\\").pop()!, ...args.slice(1, 2)]);
      if (file.endsWith("whoami.exe")) return `"host\\me","${USER}"`;
      if (args[1] === "/save") writeFileSync(String(args[2]), Buffer.from(`state\r\nD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})\r\n`, "utf16le"));
      return "";
    };
    const security = createWindowsSecurity({ env: { SystemRoot: "C:\\Windows", TEMP: root }, run: async (...args) => runner(...args), runSync: runner });
    const options = { platform: "win32" as const, windowsSecurity: security };
    await protectOwnerPrivate(folder, "directory", options);
    assert.deepEqual(calls, [["whoami.exe", "/fo"], ["icacls.exe", "/setowner"], ["icacls.exe", "/inheritance:r"], ["icacls.exe", "/save"]]);
    // The saved file is removed.
    assert.deepEqual(readdirSync(root), ["state"]);
    calls.length = 0;
    writeFileSync(join(folder, "token"), "t");
    await protectOwnerPrivate(join(folder, "token"), "file", options);
    protectOwnerPrivateSync(join(folder, "token"), "file", options);
    await createPrivateDir(join(folder, "sub"), {}, options);
    assert.equal(await isOwnerPrivate(join(folder, "token"), lstatSync(join(folder, "token")), options), true);
    assert.deepEqual(calls, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("many paths are read in a few PowerShell calls, each under the Windows environment limit", async () => {
  const sizes: number[] = [];
  const security = createWindowsSecurity({
    env: { SystemRoot: "C:\\Windows" },
    run: async (file, _args, options) => {
      if (file.endsWith("whoami.exe")) return `"h\\me","${USER}"`;
      const paths = JSON.parse(options.env.LETAGENTS_OWNER_PRIVATE_PATHS!) as string[];
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
    const { security, reads } = fakeSecurity({
      [folder]: PRIVATE_FOLDER,
      [join(folder, "token")]: INHERITED_PRIVATE,
      [join(folder, "open")]: `O:${USER}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;${USER})(A;;FR;;;BU)`,
      [join(folder, "theirs")]: `O:${OTHER}D:AI(A;ID;FA;;;SY)`,
    });
    const options = { platform: "win32" as const, windowsSecurity: security };
    // Node reports 0o666 and uid 0 for every Windows file; neither decides.
    const windowsStat = { mode: 0o100666, uid: 0 };
    // A cold check reads the file and every folder above it in one call.
    assert.equal(await isOwnerPrivate(join(folder, "open"), windowsStat, options), false);
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0]!.split("|").slice(0, 3), [join(folder, "open"), folder, root]);
    assert.equal(await isOwnerPrivate(join(folder, "theirs"), windowsStat, options), false);
    // Inherited private entries under a protected private folder: private, and the folder is now verified.
    assert.equal(await isOwnerPrivate(join(folder, "token"), windowsStat, options), true);
    const before = reads.length;
    assert.equal(isOwnerPrivateSync(join(folder, "second"), windowsStat, { ...options, exactMode: 0o600 }), true);
    assert.equal(await isOwnedByCurrentUser(join(folder, "theirs"), windowsStat, options), true);
    assert.equal(everyOwnerPrivateSync([{ path: join(folder, "open"), info: windowsStat }], options), true);
    // Nothing under a verified folder is read again.
    assert.equal(reads.length, before);
    // A path outside it still is.
    writeFileSync(join(root, "outside"), "x");
    assert.equal(await isOwnerPrivate(join(root, "outside"), windowsStat, options), false);
    assert.equal(reads.length, before + 1);
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
    assert.deepEqual(calls, [`protect:directory:${join(root, "a")}`]);
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
    const { security: fake } = fakeSecurity();
    const throwing: WindowsSecurity = { ...fake, async protect() { notStarting(); }, protectSync() { notStarting(); } };
    await assert.rejects(protectOwnerPrivate(file, "file", { platform: "win32", windowsSecurity: throwing }), { code: "EOWNERPRIVATE" });
    // Only a missing path itself is ENOENT.
    await assert.rejects(protectOwnerPrivate(join(root, "missing"), "file", options), { code: "ENOENT" });
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
    started = performance.now();
    for (let index = 0; index < 100; index += 1) {
      await writePrivateFileAtomically(join(folder, `w${index % 5}.json`), String(index));
      await protectOwnerPrivate(join(folder, `w${index % 5}.json`), "file");
      await assertOwnerPrivate(join(folder, `w${index % 5}.json`));
    }
    const hundredMs = performance.now() - started;
    console.log(`owner-private costs: protect folder ${Math.round(protectMs)} ms, cold check ${Math.round(coldCheckMs)} ms, 100 x (write + protect + check) in a private folder ${Math.round(hundredMs)} ms`);
    assert.ok(protectMs < 15_000 && coldCheckMs < 15_000);
    // No tool runs per write: 100 rounds stay far below one PowerShell start each.
    assert.ok(hundredMs < 5_000, `100 private writes took ${Math.round(hundredMs)} ms`);
  } finally { forgetOwnerPrivateCache(); rmSync(root, { recursive: true, force: true }); }
});

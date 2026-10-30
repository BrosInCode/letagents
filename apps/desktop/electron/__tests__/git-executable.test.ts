import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  expandWindowsVariables,
  gitSpawnFile,
  parseRegistryQuery,
  resetGitExecutableCacheForTests,
  resolveGitExecutable,
} from "../../../../shared/git-executable.mjs";

// Every test fakes the file system and the registry: nothing here reads the
// real registry or depends on the platform the suite runs on.

const MACHINE_PATH = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
const USER_PATH = "HKCU\\Environment";
const MACHINE_INSTALL = "HKLM\\SOFTWARE\\GitForWindows";
const USER_INSTALL = "HKCU\\SOFTWARE\\GitForWindows";

const ENV = {
  PATH: "C:\\Windows\\System32;C:\\Windows",
  ProgramFiles: "C:\\Program Files",
  LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
  USERPROFILE: "C:\\Users\\dev",
  SystemRoot: "C:\\Windows",
};

function fakes(files: string[], registry: Record<string, string> = {}) {
  const present = new Set(files);
  const reads: string[] = [];
  const checks: string[] = [];
  return {
    present,
    reads,
    checks,
    exists: (path: string) => {
      checks.push(path);
      return present.has(path);
    },
    readRegistry: (key: string, name: string) => {
      reads.push(`${key}\\${name}`);
      return registry[`${key}\\${name}`] ?? null;
    },
  };
}

function resolve(env: NodeJS.ProcessEnv, fake: ReturnType<typeof fakes>) {
  return resolveGitExecutable({ platform: "win32", env, exists: fake.exists, readRegistry: fake.readRegistry });
}

beforeEach(() => resetGitExecutableCacheForTests());

test("POSIX keeps the bare git name and reads nothing", () => {
  const fake = fakes([]);
  for (const platform of ["darwin", "linux"] as const) {
    assert.equal(resolveGitExecutable({ platform, env: ENV, exists: fake.exists, readRegistry: fake.readRegistry }), "git");
    assert.equal(gitSpawnFile({ platform, env: ENV, exists: fake.exists, readRegistry: fake.readRegistry }), "git");
  }
  assert.deepEqual(fake.reads, []);
  assert.deepEqual(fake.checks, []);
});

test("a git.exe on the current PATH wins, and the registry is not read", () => {
  const fake = fakes(
    ["D:\\Tools\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\cmd\\git.exe"],
    { [`${USER_PATH}\\Path`]: "C:\\Program Files\\Git\\cmd" },
  );
  assert.equal(resolve({ ...ENV, PATH: `${ENV.PATH};D:\\Tools\\Git\\cmd` }, fake), "D:\\Tools\\Git\\cmd\\git.exe");
  assert.deepEqual(fake.reads, []);
});

test("the registry PATH is next: machine, then user, with %VAR% expanded", () => {
  const userGit = "C:\\Users\\dev\\scoop\\apps\\git\\current\\cmd\\git.exe";
  const machineGit = "E:\\Git\\cmd\\git.exe";
  const registry = {
    [`${MACHINE_PATH}\\Path`]: "%SystemRoot%\\system32;E:\\Git\\cmd",
    [`${USER_PATH}\\Path`]: "%USERPROFILE%\\scoop\\apps\\git\\current\\cmd",
  };
  assert.equal(resolve(ENV, fakes([userGit, machineGit, "C:\\Program Files\\Git\\cmd\\git.exe"], registry)), machineGit);
  resetGitExecutableCacheForTests();
  // Expanded with the variable named in any case, and only the user PATH has Git.
  assert.equal(resolve({ ...ENV, USERPROFILE: undefined, userprofile: "C:\\Users\\dev" }, fakes([userGit], registry)), userGit);
});

test("then the places Git for Windows installs to, in order", () => {
  const programFiles = "C:\\Program Files\\Git\\cmd\\git.exe";
  const perUser = "C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\cmd\\git.exe";
  const machineInstall = "F:\\Apps\\Git\\cmd\\git.exe";
  const userInstall = "G:\\Git\\cmd\\git.exe";
  const registry = {
    [`${MACHINE_INSTALL}\\InstallPath`]: "F:\\Apps\\Git",
    [`${USER_INSTALL}\\InstallPath`]: "G:\\Git",
  };
  const order = [programFiles, perUser, machineInstall, userInstall];
  for (let index = 0; index < order.length; index += 1) {
    resetGitExecutableCacheForTests();
    assert.equal(resolve(ENV, fakes(order.slice(index), registry)), order[index]);
  }
  resetGitExecutableCacheForTests();
  const fake = fakes([], registry);
  assert.equal(resolve(ENV, fake), null);
  assert.deepEqual(fake.reads, [
    `${MACHINE_PATH}\\Path`,
    `${USER_PATH}\\Path`,
    `${MACHINE_INSTALL}\\InstallPath`,
    `${USER_INSTALL}\\InstallPath`,
  ]);
});

test("the result is always an absolute git.exe: never a .cmd or .bat, never a relative folder", () => {
  const present = [
    "C:\\Shim\\git.cmd",
    "C:\\Shim\\git.bat",
    "C:\\Shim\\git",
    "relative\\bin\\git.exe",
    "C:\\Program Files\\Git\\cmd\\git.exe",
  ];
  const fake = fakes(present);
  const found = resolve({ ...ENV, PATH: "relative\\bin;C:\\Shim;\"C:\\Program Files\\Git\\cmd\"", PATHEXT: ".CMD;.BAT;.EXE" }, fake);
  assert.equal(found, "C:\\Program Files\\Git\\cmd\\git.exe");
  assert.ok(fake.checks.length > 0);
  for (const checked of fake.checks) assert.match(checked, /^[A-Za-z]:\\.*\\git\.exe$/);
  // Only a .cmd anywhere: not found, and the spawn gets a path that cannot exist, not the batch file.
  resetGitExecutableCacheForTests();
  const onlyCmd = fakes(["C:\\Shim\\git.cmd"], { [`${USER_INSTALL}\\InstallPath`]: "C:\\Shim\\.." });
  const env = { ...ENV, PATH: "C:\\Shim" };
  assert.equal(resolve(env, onlyCmd), null);
  const spawned = gitSpawnFile({ platform: "win32", env, exists: onlyCmd.exists, readRegistry: onlyCmd.readRegistry });
  assert.match(spawned, /^C:\\Windows\\.+\\git\.exe$/);
  assert.ok(!onlyCmd.present.has(spawned));
});

test("a hit is cached; a miss is not, so Git installed while the app runs is found next time", () => {
  const git = "C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\cmd\\git.exe";
  const fake = fakes([]);
  assert.equal(resolve(ENV, fake), null);
  const readsAfterMiss = fake.reads.length;
  assert.ok(readsAfterMiss > 0);
  // Installed now; the same process asks again.
  fake.present.add(git);
  assert.equal(resolve(ENV, fake), git);
  assert.ok(fake.reads.length > readsAfterMiss, "a miss must be checked again, not cached");
  // Cached: the next call checks only the cached path and reads no registry value.
  const reads = fake.reads.length;
  fake.checks.length = 0;
  assert.equal(resolve(ENV, fake), git);
  assert.equal(fake.reads.length, reads);
  assert.deepEqual(fake.checks, [git]);
  // Uninstalled: the cached path is dropped and the search runs again.
  fake.present.delete(git);
  assert.equal(resolve(ENV, fake), null);
});

test("a cached hit belongs to one PATH", () => {
  const first = "D:\\One\\git.exe";
  const second = "D:\\Two\\git.exe";
  const fake = fakes([first, second]);
  assert.equal(resolve({ ...ENV, PATH: "D:\\One" }, fake), first);
  assert.equal(resolve({ ...ENV, PATH: "D:\\Two" }, fake), second);
});

test("reg.exe query output and %VAR% expansion", () => {
  const output = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\x\r\n\r\n";
  assert.equal(parseRegistryQuery(output, "Path"), "%USERPROFILE%\\bin;C:\\x");
  assert.equal(parseRegistryQuery("    InstallPath    REG_SZ    C:\\Program Files\\Git\r\n", "InstallPath"), "C:\\Program Files\\Git");
  assert.equal(parseRegistryQuery("ERROR: The system was unable to find the specified registry key or value.", "Path"), null);
  assert.equal(expandWindowsVariables("%UserProfile%\\a;%MISSING%\\b", { USERPROFILE: "C:\\Users\\dev" }), "C:\\Users\\dev\\a;%MISSING%\\b");
});

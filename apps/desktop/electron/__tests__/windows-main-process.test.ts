import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test, { mock } from "node:test";
import type { MenuItemConstructorOptions } from "electron";

import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({ prefix: "windows-main-process-" });

const app = { name: "LetAgents", getPath: () => "", getVersion: () => "0.0.0", isPackaged: false };
mock.module("electron", {
  defaultExport: { app, Menu: {}, shell: {}, BrowserWindow: class {}, safeStorage: {} },
  namedExports: { app, Menu: {}, shell: {}, BrowserWindow: class {}, safeStorage: {} },
});

const { letagentsHome } = await import("../../../../shared/letagents-home.mjs");
const {
  expandHomePath,
  fullFolderPathHint,
  isFullFolderPath,
  newFolderNameError,
  normalizeGitPath,
  sameLocalPath,
} = await import("../main/local-paths.js");
const { desktopPlatformCapabilities, supervisedAgentsUnsupportedResult } = await import("../main/platform-capabilities.js");
const { buildApplicationMenuTemplate } = await import("../main/menu.js");
const { isTrustedAppPageUrl } = await import("../main/window.js");
const { openDesktopCredentialStorage } = await import("../main/credential-storage.js");
const { getDesktopSupervisorGrantStorageStatus } = await import("../main/supervisor-grant.js");
const { worktreePathForBranchInPorcelain } = await import("../main/rooms/worktrees.js");
const { parseGitWorktreePorcelain } = await import("../repo-status.js");
const { windowsSourceEditor } = await import("../main/workspace-file-links.js");

test("supervised agents are off on Windows and stay on for macOS and Linux CI", () => {
  assert.deepEqual(desktopPlatformCapabilities({ platform: "win32", env: {} }), {
    platform: "win32",
    supervisedAgentsSupported: false,
    supervisorDaemonAllowed: false,
  });
  assert.deepEqual(desktopPlatformCapabilities({ platform: "darwin", env: {} }), {
    platform: "darwin",
    supervisedAgentsSupported: true,
    supervisorDaemonAllowed: true,
  });
  // Linux keeps the existing rule: IPC as usual, the daemon only with the CI override.
  assert.deepEqual(desktopPlatformCapabilities({ platform: "linux", env: {} }), {
    platform: "linux",
    supervisedAgentsSupported: true,
    supervisorDaemonAllowed: false,
  });
  assert.equal(desktopPlatformCapabilities({ platform: "linux", env: { LETAGENTS_ALLOW_NON_DARWIN_DAEMON: "1" } }).supervisorDaemonAllowed, true);
});

test("the unsupported result is typed and names Windows in plain words", () => {
  const result = supervisedAgentsUnsupportedResult("win32");
  assert.equal(result.ok, false);
  assert.equal(result.code, "unsupported_platform");
  assert.equal(result.capability, "supervised_agents");
  assert.equal(result.platform, "win32");
  assert.match(result.message, /not available on Windows yet/);
  assert.doesNotMatch(result.message, /mac|keychain/i);
});

test("the LetAgents state folder comes from the OS home folder, not HOME", () => {
  assert.equal(letagentsHome({ homedir: () => "C:\\Users\\Ada", join: win32.join }), "C:\\Users\\Ada\\.letagents");
  assert.equal(letagentsHome({ homedir: () => "/Users/ada", join: posix.join }), "/Users/ada/.letagents");
});

test("Windows folder paths: drive and network paths are full, ~\\ expands, relative forms are refused", () => {
  const home = "C:\\Users\\Ada";
  assert.equal(expandHomePath("~\\work\\repo", { platform: "win32", home }), "C:\\Users\\Ada\\work\\repo");
  assert.equal(expandHomePath("~/work/repo", { platform: "win32", home }), "C:\\Users\\Ada\\work\\repo");
  assert.equal(expandHomePath("~", { platform: "win32", home }), home);
  // "~\\" is an ordinary folder name on macOS.
  assert.equal(expandHomePath("~\\work", { platform: "darwin", home: "/Users/ada" }), "~\\work");
  assert.equal(expandHomePath("~/work", { platform: "darwin", home: "/Users/ada" }), "/Users/ada/work");

  for (const path of ["C:\\work\\repo", "d:/work/repo", "\\\\server\\share\\repo", "//server/share"]) {
    assert.equal(isFullFolderPath(path, "win32"), true, path);
  }
  for (const path of ["C:work", "\\work", "/work", "work\\repo", "\\\\server"]) {
    assert.equal(isFullFolderPath(path, "win32"), false, path);
  }
  assert.equal(isFullFolderPath("/Users/ada/repo", "darwin"), true);
  assert.equal(isFullFolderPath("C:\\work", "darwin"), false);
  assert.match(fullFolderPathHint("win32"), /drive letter/);
  assert.equal(fullFolderPathHint("darwin"), "Enter the full path to the folder, starting with / or ~/.");
});

test("Windows refuses folder names that the file system would reject", () => {
  for (const name of ["CON", "nul.txt", "COM1", "name.", "name ", "a?b", "a|b", "a\"b"]) {
    assert.match(newFolderNameError(name, "win32") ?? "", /Windows allows/, name);
  }
  assert.equal(newFolderNameError("my-project", "win32"), null);
  assert.equal(newFolderNameError("CON", "darwin"), null);
  assert.equal(newFolderNameError("a/b", "darwin"), "Enter a folder name without slashes or control characters.");
});

test("Git for Windows paths become the paths Node builds, and compare without case", () => {
  assert.equal(normalizeGitPath("C:/Users/Ada/repo", "win32"), "C:\\Users\\Ada\\repo");
  assert.equal(normalizeGitPath("c:/Users/Ada/repo", "win32"), "C:\\Users\\Ada\\repo");
  assert.equal(normalizeGitPath("//server/share/repo", "win32"), "\\\\server\\share\\repo");
  assert.equal(normalizeGitPath("/Users/ada/repo", "darwin"), "/Users/ada/repo");
  assert.equal(sameLocalPath("C:/Users/Ada/Repo", "c:\\users\\ada\\repo\\", "win32"), true);
  assert.equal(sameLocalPath("C:\\Users\\Ada\\Repo", "C:\\Users\\Ada\\Other", "win32"), false);
  // Elsewhere the strings must match exactly, as before.
  assert.equal(sameLocalPath("/Users/ada/Repo", "/Users/ada/repo", "darwin"), false);
});

const windowsPorcelain = [
  "worktree C:/Users/Ada/repo",
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  "worktree C:/Users/Ada/repo-feature-room",
  "HEAD 2222222222222222222222222222222222222222",
  "branch refs/heads/feature/room",
  "",
].join("\r\n");

test("git worktree list paths are normalised on Windows", () => {
  assert.equal(worktreePathForBranchInPorcelain(windowsPorcelain, "feature/room", "win32"), "C:\\Users\\Ada\\repo-feature-room");
  assert.equal(worktreePathForBranchInPorcelain(windowsPorcelain, "missing", "win32"), null);
  const entries = parseGitWorktreePorcelain(windowsPorcelain, "c:\\users\\ada\\repo-feature-room", "win32");
  assert.deepEqual(entries.map((entry) => [entry.path, entry.isMain, entry.isCurrent]), [
    ["C:\\Users\\Ada\\repo", true, false],
    ["C:\\Users\\Ada\\repo-feature-room", false, true],
  ]);
  const posixEntries = parseGitWorktreePorcelain("worktree /repo\nHEAD 1\n\nworktree /repo-b\nHEAD 2\n", "/repo-b", "darwin");
  assert.deepEqual(posixEntries.map((entry) => [entry.path, entry.isCurrent]), [["/repo", false], ["/repo-b", true]]);
});

function roles(items: MenuItemConstructorOptions[] | undefined): string[] {
  return (items ?? []).map((item) => item.role ?? item.label ?? item.type ?? "?");
}

test("the Windows menu is the standard File/Edit/View/Window/Help bar with no macOS-only roles", () => {
  const actions = { openSettings: () => {}, openUpdates: () => {}, openWebsite: () => {} };
  const template = buildApplicationMenuTemplate("win32", actions);
  assert.deepEqual(template.map((menu) => menu.label), ["File", "Edit", "View", "Window", "Help"]);
  const file = template[0]!.submenu as MenuItemConstructorOptions[];
  assert.deepEqual(roles(file), ["Settings...", "separator", "quit"]);
  assert.equal(file[0]!.accelerator, "CommandOrControl+,");
  assert.deepEqual(roles(template[3]!.submenu as MenuItemConstructorOptions[]), ["minimize", "close"]);
  const macOnly = new Set(["services", "hide", "hideOthers", "unhide", "front", "window", "zoom", "about"]);
  for (const menu of template) {
    for (const role of roles(menu.submenu as MenuItemConstructorOptions[])) assert.equal(macOnly.has(role), false, role);
  }

  const mac = buildApplicationMenuTemplate("darwin", actions);
  assert.deepEqual(mac.map((menu) => menu.label), ["LetAgents", "Edit", "View", "Window", "Help"]);
  assert.deepEqual(roles(mac[3]!.submenu as MenuItemConstructorOptions[]), ["minimize", "zoom", "separator", "front", "separator", "window"]);
});

test("the trusted renderer page check accepts Chromium's drive-letter case on Windows only", () => {
  const expected = "file:///c:/Program%20Files/LetAgents/resources/app/dist-renderer/index.html";
  const actual = "file:///C:/Program%20Files/LetAgents/resources/app/dist-renderer/index.html";
  assert.equal(isTrustedAppPageUrl(actual, expected, { devServer: false, platform: "win32" }), true);
  assert.equal(isTrustedAppPageUrl(actual, expected, { devServer: false, platform: "darwin" }), false);
  assert.equal(isTrustedAppPageUrl("file:///C:/Other/index.html", expected, { devServer: false, platform: "win32" }), false);
  assert.equal(isTrustedAppPageUrl("file://server/c:/Program%20Files/LetAgents/resources/app/dist-renderer/index.html", expected,
    { devServer: false, platform: "win32" }), false);
  assert.equal(isTrustedAppPageUrl("https://evil.example/index.html", expected, { devServer: false, platform: "win32" }), false);
  assert.equal(isTrustedAppPageUrl("file:///Applications/LetAgents.app/index.html", "file:///Applications/LetAgents.app/index.html",
    { devServer: false, platform: "darwin" }), true);
  assert.equal(isTrustedAppPageUrl("http://localhost:5173/x", "http://localhost:5173", { devServer: true }), true);
});

test("credential wording on Windows names the Windows account, never Keychain", async () => {
  await assert.rejects(
    openDesktopCredentialStorage({ platform: "win32", shell: { openPath: async () => "" } }),
    (error: Error) => /Windows account on this PC/.test(error.message) && !/keychain|mac/i.test(error.message),
  );
  const status = getDesktopSupervisorGrantStorageStatus({
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(""),
    decryptString: () => "",
  } as never, "win32");
  assert.equal(status.available, false);
  assert.equal(status.canOpenCredentialStorage, false);
  assert.match(status.detail ?? "", /this PC/);
  assert.doesNotMatch(status.detail ?? "", /keychain|mac/i);
});

test("the Windows editor is VS Code's Code.exe next to code.cmd on PATH, or none", () => {
  const files = new Set([
    "C:\\Users\\Ada\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd",
    "C:\\Users\\Ada\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
  ]);
  const exists = (path: string) => files.has(path);
  const env = { Path: "C:\\Windows\\System32;relative\\bin;\"C:\\Users\\Ada\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\"" };
  assert.deepEqual(windowsSourceEditor({ env, exists }), {
    id: "com.microsoft.VSCode",
    path: "C:\\Users\\Ada\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
  });
  assert.equal(windowsSourceEditor({ env: { PATH: "C:\\Windows\\System32" }, exists }), null);
  // A code.cmd without the editor next to it is not trusted.
  assert.equal(windowsSourceEditor({ env, exists: (path) => path.endsWith("code.cmd") }), null);
});

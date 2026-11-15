import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import isolation from "./preview-isolation.cjs";

const { PREVIEW_PROFILE, PREVIEW_MARKER, configureIsolatedPreview, configurePreviewSafeStorage, desktopArtifactProfile } = isolation;
const scripts = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(scripts, "../..");
const require = createRequire(import.meta.url);
const scratchBase = process.platform === "darwin" ? "/tmp" : tmpdir();

test("preview artifacts use separate identities, entrypoint and output without changing production packaging", () => {
  assert.deepEqual(desktopArtifactProfile({ platform: "darwin" }), {
    productName: "LetAgents", bundleIdentifier: "chat.letagents.desktop", protocol: "letagents",
    releaseDirectory: "LetAgents-darwin", bundle: "LetAgents.app", updater: true,
  });
  const preview = desktopArtifactProfile({ preview: true, platform: "darwin" });
  assert.equal(preview.bundleIdentifier, PREVIEW_PROFILE.bundleIdentifier);
  assert.equal(preview.protocol, "letagents-preview");
  assert.equal(preview.main, "preview-bootstrap.mjs");
  assert.equal(preview.updater, false);
  assert.notEqual(preview.releaseDirectory, desktopArtifactProfile({ platform: "darwin" }).releaseDirectory);
  assert.equal(desktopArtifactProfile({ platform: "win32" }).bundle, "LetAgents");
  assert.throws(() => desktopArtifactProfile({ preview: true, platform: "win32" }), /macOS only/);
});

test("preview requires packaged metadata and refuses linked state directories", { skip: process.platform === "win32" }, async () => {
  const temporary = await realpath(await mkdtemp(join(scratchBase, "pv-")));
  const fakeApp = { isPackaged: true, setName() {}, setPath() {} };
  try {
    assert.throws(() => configureIsolatedPreview({ app: fakeApp, profile: {}, realHome: temporary }), /packaged preview profile/);
    const outside = join(temporary, "installed-app");
    await mkdir(outside);
    await symlink(outside, join(temporary, ".letagents-preview"), "dir");
    assert.throws(() => configureIsolatedPreview({ app: fakeApp, profile: PREVIEW_PROFILE, realHome: temporary }), /real directory/);
    assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(outside)), []);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("preview isolates Electron paths and child environment without accepting inherited state or credentials", { skip: process.platform === "win32" }, async () => {
  const temporary = await realpath(await mkdtemp(join(scratchBase, "pv-")));
  const paths = {};
  const removed = [];
  const globalObject = {};
  let cwd;
  const env = {
    HOME: "/production", PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8",
    LETAGENTS_STATE_PATH: "/production/mcp.json", LETAGENTS_LOCAL_CHAT_DB: "/production/chat.sqlite",
    LETAGENTS_TOKEN: "secret", OPENAI_API_KEY: "secret", ANTHROPIC_API_KEY: "secret",
    CODEX_HOME: "/production/codex", CLAUDE_CONFIG_DIR: "/production/claude",
    NODE_OPTIONS: "--require /production/preload.js", ZDOTDIR: "/production", SSH_AUTH_SOCK: "/production/ssh",
    LETAGENTS_DESKTOP_UPDATE_BASE_URL: "https://example.invalid", LETAGENTS_DESKTOP_DEV_SERVER_URL: "http://localhost:1",
  };
  try {
    const result = configureIsolatedPreview({
      app: { isPackaged: true, setName: (name) => assert.equal(name, "LetAgents Preview"), setPath: (key, value) => { paths[key] = value; }, commandLine: { removeSwitch: (key) => removed.push(key) } },
      profile: PREVIEW_PROFILE, env, realHome: temporary, globalObject, changeDirectory: (path) => { cwd = path; },
    });
    assert.equal(env.HOME, result.home);
    assert.equal(cwd, result.home);
    assert.equal(env.CODEX_HOME, join(result.home, ".codex"));
    assert.equal(env.CLAUDE_CONFIG_DIR, join(result.home, ".claude"));
    assert.equal(env.TMPDIR, result.temp);
    assert.equal(env.LETAGENTS_STATE_PATH, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(env.LETAGENTS_DESKTOP_DEV_SERVER_URL, undefined);
    assert.ok(Object.values(paths).every((value) => value.startsWith(`${result.root}/`)));
    assert.deepEqual(Object.keys(paths), ["home", "appData", "userData", "sessionData", "logs", "crashDumps", "temp"]);
    assert.ok(removed.includes("user-data-dir"));
    assert.equal(globalObject[PREVIEW_MARKER], PREVIEW_PROFILE.id);
    assert.equal(Object.getOwnPropertyDescriptor(globalObject, PREVIEW_MARKER).writable, false);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("preview native encryption scope preserves identity, results and errors and always restores HOME", async () => {
  const realHome = await realpath(scratchBase);
  const env = { HOME: "/isolated-preview", CODEX_HOME: "/isolated-preview/.codex" };
  const app = { isPackaged: true, getName: () => PREVIEW_PROFILE.productName };
  const globalObject = { [PREVIEW_MARKER]: PREVIEW_PROFILE.id };
  const failure = new Error("native encryption refused");
  const encrypted = Buffer.from("test ciphertext");
  const calls = [];
  const safeStorage = {
    isEncryptionAvailable() { calls.push("available"); assert.equal(this, safeStorage); assert.equal(env.HOME, realHome); return true; },
    encryptString(value) {
      calls.push("encrypt"); assert.equal(this, safeStorage); assert.equal(env.HOME, realHome);
      assert.equal(env.CODEX_HOME, "/isolated-preview/.codex");
      if (value === "refused") throw failure;
      assert.equal(value, "test plaintext");
      assert.equal(this.decryptString(encrypted), "test plaintext");
      assert.equal(env.HOME, realHome, "nested calls restore the outer native scope");
      return encrypted;
    },
    decryptString(value) { calls.push("decrypt"); assert.equal(this, safeStorage); assert.equal(env.HOME, realHome); assert.equal(value, encrypted); return "test plaintext"; },
  };
  configurePreviewSafeStorage({ app, safeStorage, realHome, env, globalObject });
  assert.deepEqual(calls, [], "installing wrappers must not initiate any Keychain operation");
  assert.equal(safeStorage.isEncryptionAvailable(), true); assert.equal(env.HOME, "/isolated-preview");
  assert.equal(safeStorage.encryptString("test plaintext"), encrypted); assert.equal(env.HOME, "/isolated-preview");
  assert.equal(safeStorage.decryptString(encrypted), "test plaintext"); assert.equal(env.HOME, "/isolated-preview");
  assert.throws(() => safeStorage.encryptString("refused"), error => error === failure);
  assert.equal(env.HOME, "/isolated-preview");
  delete env.HOME;
  assert.equal(safeStorage.isEncryptionAvailable(), true); assert.equal(Object.hasOwn(env, "HOME"), false);
  assert.equal(app.getName(), PREVIEW_PROFILE.productName);
  assert.throws(() => configurePreviewSafeStorage({ app: { ...app, getName: () => "LetAgents" }, safeStorage, realHome, env, globalObject }), /isolated preview identity/);
  assert.throws(() => configurePreviewSafeStorage({ app, safeStorage: {}, realHome, env, globalObject }), /unavailable/);
  assert.throws(() => configurePreviewSafeStorage({ app, safeStorage: Object.freeze({ ...safeStorage }), realHome, env, globalObject }), TypeError);
});

test("actual preview bootstrap keeps imported storage and child HOME isolated after native encryption succeeds or fails", { skip: process.platform === "win32" }, async () => {
  const temporary = await realpath(await mkdtemp(join(scratchBase, "pv-")));
  try {
    const home = join(temporary, "owner");
    const app = join(temporary, "app");
    await mkdir(join(home, ".letagents"), { recursive: true });
    await writeFile(join(home, ".letagents", "local-chat.sqlite"), "installed app sentinel");
    await mkdir(join(app, "dist-electron"), { recursive: true });
    await mkdir(join(app, "node_modules", "electron"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ type: "module", letagentsPreview: PREVIEW_PROFILE }));
    for (const name of ["preview-bootstrap.mjs", "preview-isolation.cjs"]) await cp(join(scripts, name), join(app, name));
    await writeFile(join(app, "node_modules", "electron", "index.js"), `
      let name; const paths = {}; const calls = [];
      const app = { isPackaged: true, setPath(key, value) { paths[key] = value; }, setName(value) { name = value; }, getName() { return name; }, exit: process.exit };
      const safeStorage = {
        isEncryptionAvailable() { calls.push({home:process.env.HOME, name, appHome:paths.home, method:'available'}); return true; },
        encryptString(value) { calls.push({home:process.env.HOME, name, appHome:paths.home, method:'encrypt'}); if(value === 'refused') throw new Error('native refused'); return Buffer.from(value); },
        decryptString(value) { calls.push({home:process.env.HOME, name, appHome:paths.home, method:'decrypt'}); return value.toString(); }
      }; module.exports = { app, safeStorage, calls };`);
    // Only the OS home lookup is replaced, so this test never visits the real
    // account's preview directory. The production bootstrap runs unchanged.
    await writeFile(join(app, "run.mjs"), `import os from 'node:os'; os.userInfo = () => ({homedir:${JSON.stringify(home)}}); await import('./preview-bootstrap.mjs'); if (!globalThis.previewImportCompleted) throw new Error('bootstrap did not await main');`);
    const url = (path) => JSON.stringify(pathToFileURL(join(desktop, path)).href);
    await writeFile(join(app, "dist-electron", "main.js"), `
      import { homedir } from 'node:os';
      import { spawnSync } from 'node:child_process';
      import electron from 'electron';
      import { localChatDatabasePath } from ${url("electron/main/chat-storage/settings.ts")};
      import { getLocalChatDatabase } from ${url("electron/main/rooms/local-db.ts")};
      import { defaultDaemonPaths } from ${url("daemon/singleton.ts")};
      await new Promise(resolve => setTimeout(resolve, 20));
      globalThis.previewImportCompleted = true;
      if (electron.calls.length) throw new Error('bootstrap initiated an unexpected crypto operation');
      const db = await getLocalChatDatabase(); db.exec('CREATE TABLE preview_proof (value TEXT)');
      db.exec("INSERT INTO preview_proof VALUES ('isolated')"); db.close();
      const childHome = () => spawnSync(process.execPath, ['-e', 'console.log(require("node:os").homedir())'], {encoding:'utf8'}).stdout.trim();
      const children = [childHome()];
      if (!electron.safeStorage.isEncryptionAvailable()) throw new Error('fake storage unavailable');
      if (electron.safeStorage.decryptString(electron.safeStorage.encryptString('roundtrip')) !== 'roundtrip') throw new Error('roundtrip changed');
      children.push(childHome());
      try { electron.safeStorage.encryptString('refused'); throw new Error('missing refusal'); }
      catch(error) { if(error.message !== 'native refused') throw error; }
      children.push(childHome());
      console.log(JSON.stringify({home:homedir(), cwd:process.cwd(), db:localChatDatabasePath, daemon:defaultDaemonPaths(), children, crypto:electron.calls, credential:process.env.LETAGENTS_TOKEN ?? null}));
    `);
    const child = spawnSync(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, join(app, "run.mjs")], {
      cwd: desktop, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, HOME: home, LETAGENTS_LOCAL_CHAT_DB: join(home, ".letagents", "local-chat.sqlite"), LETAGENTS_TOKEN: "production-token" },
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim());
    const previewHome = join(home, ".letagents-preview", "home");
    assert.equal(result.home, previewHome);
    assert.equal(result.cwd, previewHome);
    assert.deepEqual(result.children, [previewHome, previewHome, previewHome]);
    assert.deepEqual(result.crypto.map(call => call.method), ["available", "encrypt", "decrypt", "encrypt"]);
    assert.ok(result.crypto.every(call => call.home === home && call.name === PREVIEW_PROFILE.productName && call.appHome === previewHome));
    assert.equal(result.credential, null);
    assert.equal(result.db, join(previewHome, ".letagents", "local-chat.sqlite"));
    assert.equal(result.daemon.socketPath, join(previewHome, ".letagents", "daemon.sock"));
    assert.equal(result.daemon.manifestPath, join(previewHome, ".letagents", "daemon-state.sqlite"));
    assert.equal(await readFile(join(home, ".letagents", "local-chat.sqlite"), "utf8"), "installed app sentinel");
    assert.equal((await readFile(result.db)).subarray(0, 15).toString(), "SQLite format 3");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

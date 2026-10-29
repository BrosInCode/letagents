// Counts file reads, queries, RPCs and decrypts per call for the desktop main-process caches.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { writeFile } from "node:fs/promises";
import test, { mock } from "node:test";

import { join } from "node:path";
import { createElectronTestEnv, installTestSecretStorage } from "./harness.js";

const env = createElectronTestEnv({
  prefix: "letagents-main-perf-",
  paths: ["state", "chatStorage", "localChatDb", "localProfile"],
});

const registryPath = join(env.tempDir, "supervisor-grant.json");
process.env.LETAGENTS_SUPERVISOR_GRANT_STORE_PATH = registryPath;
test.after(() => { delete process.env.LETAGENTS_SUPERVISOR_GRANT_STORE_PATH; });

// Count reads of the chat-storage file and mkdir calls without changing behavior.
const counts = { settingsReads: 0, filesMkdirs: 0, registryReads: 0, stateReads: 0 };
const originalReadFile = fsPromises.readFile;
const originalMkdir = fsPromises.mkdir;
fsPromises.readFile = (async (...args: Parameters<typeof originalReadFile>) => {
  if (String(args[0]) === env.chatStorageSettingsPath) counts.settingsReads += 1;
  if (String(args[0]) === registryPath) counts.registryReads += 1;
  return originalReadFile(...args);
}) as typeof originalReadFile;
fsPromises.mkdir = (async (...args: Parameters<typeof originalMkdir>) => {
  if (String(args[0]).endsWith("local-files")) counts.filesMkdirs += 1;
  return originalMkdir(...args);
}) as typeof originalMkdir;
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = ((...args: Parameters<typeof originalReadFileSync>) => {
  if (String(args[0]) === env.statePath) counts.stateReads += 1;
  return originalReadFileSync(...args);
}) as typeof originalReadFileSync;
// Windows reads the state file through a handle it opens after checking the file's DACL.
const originalOpenSync = fs.openSync;
fs.openSync = ((...args: Parameters<typeof originalOpenSync>) => {
  if (process.platform === "win32" && String(args[0]) === env.statePath) counts.stateReads += 1;
  return originalOpenSync(...args);
}) as typeof originalOpenSync;
syncBuiltinESMExports();

const { getLocalChatDatabase } = await import("../main/rooms/local-db.js");
const settings = await import("../main/chat-storage/settings.js");
const localStore = await import("../main/rooms/local-store.js");
const messages = await import("../main/rooms/messages/local-store.js");

// Count real SQLite statement compiles. The patch must land before the first connection opens.
let prepares = 0;
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: { prototype: { prepare: (sql: string) => unknown } };
};
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function patchedPrepare(this: unknown, sql: string) {
  prepares += 1;
  return originalPrepare.call(this, sql);
};
async function countPrepares(): Promise<void> {
  await getLocalChatDatabase();
}

test("item 1: resolving room storage reads the settings file and prepares once, not on every call", async () => {
  const room = await localStore.createLocalRoom({ displayName: "Perf room" });
  await countPrepares();
  await localStore.resolveLocalAwareRoomStorageMode(room.roomIdentifier); // warm
  counts.settingsReads = 0;
  counts.filesMkdirs = 0;
  prepares = 0;
  for (let index = 0; index < 20; index += 1) {
    const storage = await localStore.resolveLocalAwareRoomStorageMode(room.roomIdentifier);
    assert.equal(storage.isLocalRoom, true);
  }
  console.log(`item1 per 20 calls: settingsReads=${counts.settingsReads} mkdirs=${counts.filesMkdirs} prepares=${prepares}`);
  assert.equal(counts.settingsReads, 0, "settings file is served from memory while it is unchanged");
  assert.equal(counts.filesMkdirs, 0, "local-files mkdir only runs on schema init");
  assert.equal(prepares, 0, "room lookup statements are reused");
});

test("item 1: our own settings write is visible at once", async () => {
  assert.equal((await settings.resolveRoomStorageMode("cloud-alias-room")).overrideMode, "inherit");
  await settings.setRoomStorageMode("cloud-alias-room", "cloud");
  assert.equal((await settings.resolveRoomStorageMode("cloud-alias-room")).overrideMode, "cloud");
  await settings.setRoomStorageMode("cloud-alias-room", "inherit");
  assert.equal((await settings.resolveRoomStorageMode("cloud-alias-room")).overrideMode, "inherit");
});

test("item 1: a write by another process (changed file) is picked up", async () => {
  await settings.setChatStorageMode("cloud");
  assert.equal((await settings.readChatStorageSettings()).mode, "cloud");
  await writeFile(
    env.chatStorageSettingsPath!,
    `${JSON.stringify({ defaultMode: "local", roomOverrides: { "other-room": "cloud" } }, null, 2)}\n`,
    "utf8",
  );
  const next = await settings.readChatStorageSettings();
  assert.equal(next.mode, "local");
  assert.equal(next.roomOverrides["other-room"], "cloud");
  await writeFile(env.chatStorageSettingsPath!, "not json", "utf8");
  assert.equal((await settings.readChatStorageSettings()).mode, "cloud", "unreadable file falls back to cloud");
  await settings.setChatStorageMode("cloud");
});

test("item 1: callers cannot mutate the cached settings", async () => {
  await settings.setChatStorageMode("cloud");
  const first = await settings.readChatStorageSettings();
  first.roomOverrides["leak"] = "local";
  assert.equal((await settings.readChatStorageSettings()).roomOverrides["leak"], undefined);
});

test("item 2: message reads reuse prepared statements", async () => {
  const room = await localStore.createLocalRoom({ displayName: "Messages room" });
  await countPrepares();
  await messages.addLocalChatMessage(room.roomIdentifier, { sender: "tester", text: "hello" });
  await messages.getLocalChatMessages(room.roomIdentifier, { limit: 20 }); // warm
  prepares = 0;
  for (let index = 0; index < 20; index += 1) {
    await messages.getLocalChatMessages(room.roomIdentifier, { limit: 20 });
  }
  console.log(`item2 per 20 getLocalChatMessages: prepares=${prepares}`);
  assert.equal(prepares, 0);
});

test("item 3: the change stamp moves on an own write and on a commit by another connection", async () => {
  const { readDatabaseChangeStamp } = await import("../main/rooms/prepared-statements.js");
  const room = await localStore.createLocalRoom({ displayName: "Stamp room" });
  const db = await localStore.getLocalTaskDatabase();
  const idle = readDatabaseChangeStamp(db);
  assert.equal(readDatabaseChangeStamp(db), idle, "no change, same stamp");
  await messages.addLocalChatMessage(room.roomIdentifier, { sender: "tester", text: "own write" });
  const afterOwn = await messages.getLocalChatChangeStamp();
  assert.notEqual(afterOwn, idle);
  assert.equal(await messages.getLocalChatChangeStamp(), afterOwn);
  const { DatabaseSync: Other } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string) => { exec: (sql: string) => void; close: () => void };
  };
  const other = new Other(env.localChatDbPath!);
  try {
    other.exec("CREATE TABLE IF NOT EXISTS foreign_writer (n INTEGER); INSERT INTO foreign_writer VALUES (1)");
  } finally {
    other.close();
  }
  assert.notEqual(await messages.getLocalChatChangeStamp(), afterOwn, "another process commit is seen");
});

test("item 2: the statement cache is bounded and evicts the least recently used SQL", async () => {
  const { MAX_CACHED_STATEMENTS, withStatementCache } = await import("../main/rooms/prepared-statements.js");
  const compiled: string[] = [];
  const fake = {
    exec: () => {},
    prepare: (sql: string) => {
      compiled.push(sql);
      return { all: () => [], get: () => undefined, run: () => undefined };
    },
  };
  const cached = withStatementCache(fake);
  assert.equal(withStatementCache(fake), cached, "one facade per connection");
  cached.prepare("SELECT 0");
  cached.prepare("SELECT 0");
  assert.deepEqual(compiled, ["SELECT 0"]);
  for (let index = 1; index <= MAX_CACHED_STATEMENTS; index += 1) cached.prepare(`SELECT ${index}`);
  compiled.length = 0;
  cached.prepare(`SELECT ${MAX_CACHED_STATEMENTS}`);
  assert.deepEqual(compiled, [], "recent SQL stays cached");
  cached.prepare("SELECT 0");
  assert.deepEqual(compiled, ["SELECT 0"], "oldest SQL was evicted at the bound");
});

function registryFile(entryAgentKeys: Record<string, string>): string {
  return `${JSON.stringify({ version: 7, grants: {}, entryAgentKeys, credentialRevocations: {}, purgeRevocationReceipts: {} })}\n`;
}

test("item 5: the grant registry is read once while its file is unchanged, and again after any change", async () => {
  const grant = await import("../main/supervisor-grant.js");
  await writeFile(registryPath, registryFile({ entry_1: "agent/one" }), "utf8");
  grant.clearDesktopSupervisorGrantRegistryCacheForTest();
  counts.registryReads = 0;
  for (let index = 0; index < 20; index += 1) {
    const keys = await grant.readDesktopSupervisorGrantAgentKeysForEntries(["entry_1", "entry_2"]);
    assert.equal(keys.get("entry_1"), "agent/one");
    assert.equal(keys.has("entry_2"), false);
  }
  console.log(`item5 per 20 list-agents projections: registry reads=${counts.registryReads}`);
  assert.equal(counts.registryReads, 1);
  // A different size (and mtime) is a change, even from another process.
  await writeFile(registryPath, registryFile({ entry_1: "agent/one", entry_2: "agent/two-longer" }), "utf8");
  assert.equal((await grant.readDesktopSupervisorGrantAgentKeysForEntries(["entry_2"])).get("entry_2"), "agent/two-longer");
  assert.equal(counts.registryReads, 2);
  // Removing the file means no grant at all.
  await grant.clearDesktopSupervisorGrant();
  assert.equal((await grant.readDesktopSupervisorGrantAgentKeysForEntries(["entry_1"])).size, 0);
  assert.equal(await grant.readDesktopSupervisorGrantAgentKeyForEntry("entry_1"), null);
});

test("item 5: the Keychain probe is cached 30 s when it succeeds and never when it fails", async () => {
  installTestSecretStorage();
  const grant = await import("../main/supervisor-grant.js");
  const electronModule = createRequire(import.meta.url)("electron") as {
    safeStorage: { isEncryptionAvailable: () => boolean; encryptString: (value: string) => Buffer };
  };
  const storage = electronModule.safeStorage;
  const originalEncrypt = storage.encryptString;
  const originalAvailable = storage.isEncryptionAvailable;
  let encrypts = 0;
  storage.encryptString = (value: string) => { encrypts += 1; return originalEncrypt(value); };
  try {
    grant.clearDesktopSupervisorGrantStorageStatusCache();
    for (let index = 0; index < 10; index += 1) assert.equal(grant.getDesktopSupervisorGrantStorageStatus().available, true);
    console.log(`item5 per 10 Add-Agent preflights: Keychain encrypt probes=${encrypts}`);
    assert.equal(encrypts, 1);
    // A failed real encrypt clears the cache, so the next preflight probes again.
    storage.isEncryptionAvailable = () => false;
    assert.throws(() => grant.encryptSupervisorGrantForStorage("token"), /unavailable/i);
    assert.equal(grant.getDesktopSupervisorGrantStorageStatus().available, false);
    storage.isEncryptionAvailable = originalAvailable;
    assert.equal(grant.getDesktopSupervisorGrantStorageStatus().available, true, "a failure is never kept");
    assert.equal(encrypts, 2);
  } finally {
    storage.encryptString = originalEncrypt;
    storage.isEncryptionAvailable = originalAvailable;
    grant.clearDesktopSupervisorGrantStorageStatusCache();
  }
});

function countingSecretStorage() {
  const state = { decrypts: 0, locked: false };
  return {
    state,
    storage: {
      isEncryptionAvailable: () => !state.locked,
      encryptString: (value: string) => Buffer.from(`enc:${value}`),
      decryptString: (value: Buffer) => {
        state.decrypts += 1;
        if (state.locked) throw new Error("locked");
        return value.toString().replace(/^enc:/, "");
      },
    },
  };
}

test("item 8: Open Model settings decrypt once while the file is unchanged, and again after a save or an outside edit", async () => {
  const settings = await import("../main/agents/open-model-settings.js");
  const { state, storage } = countingSecretStorage();
  const storePath = join(env.tempDir, "open-model.json");
  await settings.saveOpenModelSettings({ apiKey: "secret-key", baseUrl: "https://example.test/v1", model: "m1" }, { storePath, secretStorage: storage });
  settings.clearOpenModelSettingsCacheForTest();
  state.decrypts = 0;
  for (let index = 0; index < 20; index += 1) {
    assert.equal((await settings.readOpenModelSettings({ storePath, secretStorage: storage })).apiKey, "secret-key");
  }
  console.log(`item8 per 20 Open Model settings reads: decrypts=${state.decrypts}`);
  assert.equal(state.decrypts, 1);
  const first = await settings.readOpenModelSettings({ storePath, secretStorage: storage });
  first.model = "mutated by a caller";
  assert.equal((await settings.readOpenModelSettings({ storePath, secretStorage: storage })).model, "m1");
  await settings.saveOpenModelSettings({ model: "m2" }, { storePath, secretStorage: storage });
  assert.equal((await settings.readOpenModelSettings({ storePath, secretStorage: storage })).model, "m2", "a save is visible at once");
  await writeFile(storePath, `${JSON.stringify({ encryptedApiKey: "safe:" + Buffer.from("enc:other-key").toString("base64"), baseUrl: "https://example.test/v1", model: "outside" })}\n`, "utf8");
  const edited = await settings.readOpenModelSettings({ storePath, secretStorage: storage });
  assert.equal(edited.model, "outside");
  assert.equal(edited.apiKey, "other-key");
  // A locked Keychain is never kept: the next read tries again.
  state.locked = true;
  settings.clearOpenModelSettingsCacheForTest();
  assert.equal((await settings.readOpenModelSettings({ storePath, secretStorage: storage })).apiKey, null);
  state.locked = false;
  assert.equal((await settings.readOpenModelSettings({ storePath, secretStorage: storage })).apiKey, "other-key");
});

test("item 8: App Agent settings follow the same rules", async () => {
  const settings = await import("../main/app-agent/settings.js");
  const { state, storage } = countingSecretStorage();
  const storePath = join(env.tempDir, "app-agent.json");
  await settings.saveAppAgentSettings({ openRouterApiKey: "router-key", enabled: true, model: "m1" }, { storePath, secretStorage: storage });
  settings.clearAppAgentSettingsCacheForTest();
  state.decrypts = 0;
  for (let index = 0; index < 20; index += 1) {
    assert.equal((await settings.readAppAgentSettings({ storePath, secretStorage: storage })).openRouterApiKey, "router-key");
  }
  console.log(`item8 per 20 App Agent settings reads: decrypts=${state.decrypts}`);
  assert.equal(state.decrypts, 1);
  await settings.saveAppAgentSettings({ model: "m2" }, { storePath, secretStorage: storage });
  assert.equal((await settings.readAppAgentSettings({ storePath, secretStorage: storage })).model, "m2");
  state.locked = true;
  settings.clearAppAgentSettingsCacheForTest();
  assert.equal((await settings.readAppAgentSettings({ storePath, secretStorage: storage })).openRouterApiKey, null);
  state.locked = false;
  assert.equal((await settings.readAppAgentSettings({ storePath, secretStorage: storage })).openRouterApiKey, "router-key");
});

test("item 9: joined-room info expires after the TTL and the map keeps at most the cap, newest first", async () => {
  const info = await import("../main/rooms/room-info.js");
  info.clearJoinedRoomInfoCache();
  let nowMs = 5_000_000;
  const dateNow = mock.method(Date, "now", () => nowMs);
  const previousFetch = globalThis.fetch;
  let joins = 0;
  globalThis.fetch = (async () => {
    joins += 1;
    return new Response(JSON.stringify({ room_id: "room-ttl", name: `name-${joins}` }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    assert.equal((await info.getJoinedRoomInfo("room-ttl")).name, "name-1");
    for (let index = 0; index < 5; index += 1) await info.getJoinedRoomInfo("room-ttl");
    assert.equal(joins, 1, "hits inside the TTL make no request");
    nowMs += info.JOINED_ROOM_INFO_TTL_MS - 1;
    assert.equal((await info.getJoinedRoomInfo("room-ttl")).name, "name-1");
    nowMs += 2;
    assert.equal((await info.getJoinedRoomInfo("room-ttl")).name, "name-2", "a rename shows up after the TTL");
    assert.equal(joins, 2);

    info.clearJoinedRoomInfoCache();
    info.rememberJoinedRoomInfo("keep-me", { room_id: "keep-me", name: "kept" });
    for (let index = 0; index < info.JOINED_ROOM_INFO_MAX_ENTRIES + 20; index += 1) {
      info.rememberJoinedRoomInfo(`filler-${index}`, { room_id: `filler-${index}`, name: "filler" });
      if (index % 50 === 0) await info.getJoinedRoomInfo("keep-me"); // a hit keeps it newest
    }
    joins = 0;
    assert.equal((await info.getJoinedRoomInfo("keep-me")).name, "kept", "a busy room survives the cap");
    assert.equal(joins, 0);
    await info.getJoinedRoomInfo("filler-0");
    assert.equal(joins, 1, "the oldest idle room was dropped at the cap");
  } finally {
    globalThis.fetch = previousFetch;
    dateNow.mock.restore();
    info.clearJoinedRoomInfoCache();
  }
});

test("item 10: the host id is read from the state file once, then reused until the file is gone or the recheck time passes", async () => {
  const agentState = await import("../main/agents/state.js");
  agentState.clearDesktopHostIdCacheForTest();
  const first = agentState.getOrCreateDesktopHostId();
  assert.match(first, /^host_[a-f0-9]{32}$/);
  counts.stateReads = 0;
  for (let index = 0; index < 20; index += 1) assert.equal(agentState.getOrCreateDesktopHostId(), first);
  console.log(`item10 per 20 getOrCreateDesktopHostId calls: state file reads=${counts.stateReads}`);
  assert.equal(counts.stateReads, 0);
  // A removed state file means the id must be resolved again, not served from memory.
  await fsPromises.rm(env.statePath!, { force: true });
  const second = agentState.getOrCreateDesktopHostId();
  assert.notEqual(second, first);
  assert.equal(agentState.getOrCreateDesktopHostId(), second);
  // After the recheck time the file is read again.
  const realNow = Date.now();
  const dateNow = mock.method(Date, "now", () => realNow + 31_000);
  try {
    counts.stateReads = 0;
    assert.equal(agentState.getOrCreateDesktopHostId(), second);
    assert.equal(counts.stateReads > 0, true);
  } finally {
    dateNow.mock.restore();
  }
});

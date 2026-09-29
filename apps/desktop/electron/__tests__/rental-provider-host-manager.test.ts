import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RentalProviderHostManager } from "../rental/provider-host-manager.js";

test("preflights disabled runtimes, then publishes provider limits and authenticated offers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-settings-"));
  const previous = process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH;
  process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH = join(directory, "settings.json");
  const oldJournal = process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
  process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = join(directory, "launches.json");
  t.after(() => { if (oldJournal === undefined) delete process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH; else process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = oldJournal; });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const api = {
    async heartbeatProviderHost(_hostId: string, body: Record<string, unknown>) {
      calls.push({ method: "heartbeat", body });
      return { ok: false as const, status: 404, error: "not_found", body: null };
    },
    async registerProviderHost(body: Record<string, unknown>) {
      calls.push({ method: "register", body });
      return { ok: true as const, status: 201, body: { host: {} } };
    },
  };
  const daemon = {
    async isMaintenanceHeld() { return false; },
    async connectIfRunning() { return { generation: 12 }; },
    async list() { return []; },
  };
  let preflights = 0;
  const manager = new RentalProviderHostManager(
    api as never,
    daemon as never,
    () => "host_public_local",
    async () => {
      preflights += 1;
      return { canStart: true, status: "ready" } as never;
    },
  );

  try {
    const before = await manager.getSettings();
    assert.ok(before.runtimes.length >= 4);
    assert.ok(before.runtimes.every((runtime) => !runtime.enabled && runtime.authenticated));

    const after = await manager.updateSettings({
      enabled: true,
      maxConcurrentSessions: 3,
      defaultTimeLimitMinutes: 75,
      defaultLrtLimit: 125_000,
      runtimes: [{ providerId: "cursor", enabled: true }],
    });
    assert.equal(after.enabled, true);
    assert.equal(after.runtimes.find((runtime) => runtime.providerId === "cursor")?.enabled, true);
    assert.deepEqual(after.runtimes.find((runtime) => runtime.providerId === "codex")?.permissionProfileIds, []);
    assert.equal(after.runtimes.find((runtime) => runtime.providerId === "codex")?.status, "blocked");
    assert.equal(preflights, before.runtimes.length, "the bounded cache prevents duplicate CLI probes");

    const heartbeat = calls.find((call) => call.method === "heartbeat")?.body;
    const registration = calls.find((call) => call.method === "register")?.body;
    assert.equal(heartbeat?.defaultTimeLimitMinutes, 75);
    assert.equal(heartbeat?.defaultLrtLimit, 125_000);
    assert.equal(heartbeat?.manualAcceptRequired, true);
    assert.deepEqual(heartbeat?.runtimes, [{
      kind: "cursor",
      label: "Cursor",
      authenticated: true,
      permissionProfiles: ["sandboxed_write"],
    }]);
    assert.equal(registration?.hostId, "host_public_local");
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH;
    else process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH = previous;
  }
});

test("sync clears its in-flight promise so later heartbeats are not frozen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-settings-"));
  const previous = process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH;
  process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH = join(directory, "settings.json");
  const oldJournal = process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
  process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = join(directory, "launches.json");
  t.after(() => { if (oldJournal === undefined) delete process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH; else process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = oldJournal; });
  let heartbeats = 0;
  const manager = new RentalProviderHostManager(
    {
      async heartbeatProviderHost() {
        heartbeats += 1;
        return { ok: true as const, status: 200, body: { host: {} } };
      },
    } as never,
    {
      async isMaintenanceHeld() { return false; },
    async connectIfRunning() { return { generation: 1 }; },
      async list() { return []; },
    } as never,
    () => "host",
    async () => ({ canStart: true, status: "ready" }) as never,
  );
  try {
    await manager.sync();
    await manager.sync();
    assert.equal(heartbeats, 2);
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH;
    else process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH = previous;
  }
});


test("maintenance keeps rental availability off and refuses settings without preflight or publication", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-settings-"));
  const previous = process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH;
  process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH = join(directory, "settings.json");
  const oldJournal = process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
  process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = join(directory, "launches.json");
  t.after(() => { if (oldJournal === undefined) delete process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH; else process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = oldJournal; });
  t.after(() => { if (previous === undefined) delete process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH; else process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH = previous; });
  const available: boolean[] = [];
  const manager = new RentalProviderHostManager({ heartbeatProviderHost: async () => assert.fail("heartbeat"), registerProviderHost: async () => assert.fail("register") } as never,
    { isMaintenanceHeld: async () => true, connectIfRunning: async () => assert.fail("daemon negotiation") } as never,
    () => "inert-host", async () => assert.fail("native preflight"), async enabled => { available.push(enabled); });
  const before = await manager.getSettings();
  assert.equal(before.daemonState, "offline"); assert.match(before.blockers.join(" "), /maintenance/);
  assert.ok(before.runtimes.every(runtime => runtime.status === "blocked"));
  await manager.sync();
  await assert.rejects(manager.updateSettings({ enabled: true }), /maintenance/);
  assert.deepEqual(await manager.getSettings(), before);
  assert.deepEqual(available, [false]);
});

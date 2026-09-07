import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RentalProviderHostManager } from "../rental/provider-host-manager.js";

test("preflights disabled runtimes, then publishes provider limits and authenticated offers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-settings-"));
  const previous = process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH;
  process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH = join(directory, "settings.json");
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
    assert.equal(before.runtimes.find((runtime) => runtime.providerId === "cursor")?.rentalSandboxStatus, "verified");
    assert.equal(before.runtimes.find((runtime) => runtime.providerId === "codex")?.rentalSandboxStatus, "unsupported");
    assert.match(
      before.runtimes.find((runtime) => runtime.providerId === "codex")?.detail || "",
      /renting is not available in this version/,
    );

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

test("runtime verification bypasses the bounded preflight cache for the selected safe runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-verify-"));
  const previous = process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH;
  process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH = join(directory, "settings.json");
  const calls = new Map<string, number>();
  const manager = new RentalProviderHostManager(
    {
      async heartbeatProviderHost() {
        return { ok: true as const, status: 200, body: { host: {} } };
      },
    } as never,
    {
      async connectIfRunning() { return { generation: 1 }; },
      async list() { return []; },
    } as never,
    () => "host",
    async (providerId) => {
      const count = (calls.get(providerId) || 0) + 1;
      calls.set(providerId, count);
      return count === 1 && providerId === "cursor"
        ? { canStart: false, status: "auth_required", detail: "Sign in with Cursor Agent." } as never
        : { canStart: true, status: "ready", detail: "Verified." } as never;
    },
  );
  try {
    const before = await manager.getSettings();
    assert.equal(before.runtimes.find((runtime) => runtime.providerId === "cursor")?.rentalSandboxStatus, "verification_required");
    assert.equal(calls.get("cursor"), 1);

    const after = await manager.verifyRuntime("cursor");
    assert.equal(after.runtimes.find((runtime) => runtime.providerId === "cursor")?.rentalSandboxStatus, "verified");
    assert.equal(calls.get("cursor"), 2);
    assert.equal(calls.get("codex"), 1, "verification does not rerun unrelated provider probes");

    await assert.rejects(
      () => manager.verifyRuntime("codex"),
      /renting is not available in this version/,
    );
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH;
    else process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH = previous;
  }
});

test("sync clears its in-flight promise so later heartbeats are not frozen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-settings-"));
  const previous = process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH;
  process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH = join(directory, "settings.json");
  let heartbeats = 0;
  const manager = new RentalProviderHostManager(
    {
      async heartbeatProviderHost() {
        heartbeats += 1;
        return { ok: true as const, status: 200, body: { host: {} } };
      },
    } as never,
    {
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

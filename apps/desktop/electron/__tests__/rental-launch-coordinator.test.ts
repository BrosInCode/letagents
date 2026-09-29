import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { RentalLaunchCoordinator } from "../rental/launch-coordinator.js";
import { listRentalLaunches, pruneRentalLaunches, readRentalLaunch, writeRentalLaunch } from "../rental/launch-journal.js";

const restoredGrants = {
  getReconciliationObservation() {
    return { attempt: restoredGrantAttempt, status: "succeeded", current: true, error: undefined };
  },
};
const restoredGrantAttempt = Promise.resolve();

async function recoveryFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-grant-order-"));
  const previous = process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
  const path = join(directory, "launches.json");
  process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = path;
  const launch = { sessionId: "rsess_grant", launchAttempt: 3, entryId: "entry_grant", roomId: "room_canonical",
    state: "active" as const, updatedAt: new Date().toISOString() };
  await writeRentalLaunch(launch);
  const entry = { id: launch.entryId, roomId: launch.roomId, provider: "cursor", permissionProfileId: "sandboxed_write",
    desiredState: "running", observedState: "recovering", condition: "auth_blocked", agentSessionId: "same_worker",
    agentSessionBindingState: "historical", readyReachedAt: "2026-09-27T00:00:00.000Z" };
  let observation = { attempt: new Promise<void>(() => {}), status: "pending", current: true, error: undefined as unknown };
  const calls = { grants: 0, complete: 0, stop: 0, purge: 0, refresh: 0, ack: 0, list: 0 };
  const api = {
    async getSession() { calls.refresh++; return { ok: true as const, status: 200, body: session({ id: launch.sessionId, status: "active" }) }; },
    async completeSession() { calls.complete++; return { ok: true as const, status: 200, body: session({ status: "completed" }) }; },
    async acknowledgeLaunch() { calls.ack++; return { ok: true as const, status: 200, body: session({ status: "active" }) }; },
  };
  const daemon = {
    async list() { calls.list++; return [entry]; },
    async setDesiredState() { calls.stop++; entry.desiredState = "stopped"; entry.observedState = "stopped"; },
    async isMaintenanceHeld() { return false; },
    async ensureRunning() { return { generation: 1 }; },
    async purgeAgent() { calls.purge++; return { outcome: "purged" }; },
  };
  const grants = {
    getReconciliationObservation() { return observation; },
    async reconcileDesiredRunning(): Promise<void> { calls.grants++; throw new Error("rental must not retry an existing attempt"); },
  };
  const coordinator = new RentalLaunchCoordinator(api as never, daemon as never, grants as never);
  const internal = coordinator as unknown as { reconcileActiveSessions(): Promise<void>;
    reconcileTimer: ReturnType<typeof setInterval> | null; deadlineTimers: Map<string, ReturnType<typeof setTimeout>> };
  t.after(() => {
    if (internal.reconcileTimer) clearInterval(internal.reconcileTimer);
    for (const timer of internal.deadlineTimers.values()) clearTimeout(timer);
    if (previous === undefined) delete process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
    else process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = previous;
  });
  return { path, launch, entry, calls, api, daemon, grants, coordinator, tick: () => internal.reconcileActiveSessions(),
    observe(status: string, current = true, error?: unknown) { observation = { attempt: Promise.resolve(), status, current, error }; },
  };
}

test("grant recovery preserves an uncertain worker across initial and periodic passes without retrying grants", async (t) => {
  const h = await recoveryFixture(t);
  await h.coordinator.recover();
  for (let i = 0; i < 3; i++) await h.tick();
  assert.equal(h.calls.complete, 0);
  assert.equal(h.calls.stop, 0);
  assert.equal(h.calls.grants, 0);
  assert.equal(h.calls.refresh, 4, "a pending grant cannot block independent remote terminal observations");
  assert.deepEqual(await readRentalLaunch(h.launch.sessionId), h.launch);
  const failure = new Error("restoration failed");
  h.observe("failed", true, failure);
  await assert.rejects(h.tick(), failure);
  for (let i = 0; i < 3; i++) await h.tick();
  assert.equal(h.calls.complete, 0);
  assert.equal(h.calls.grants, 0, "a failed attempt is not a rental polling retry trigger");
  h.entry.agentSessionBindingState = "active";
  h.entry.observedState = "running";
  h.entry.condition = "none";
  h.observe("succeeded");
  await h.tick();
  assert.equal(h.calls.complete, 0);
  assert.deepEqual(await readRentalLaunch(h.launch.sessionId), h.launch);
});

test("grant recovery still fences a historical binding after a current successful restoration", async (t) => {
  const h = await recoveryFixture(t);
  h.observe("succeeded");
  await h.coordinator.recover();
  assert.equal(h.calls.complete, 1);
  assert.equal(h.calls.purge, 1);
  assert.equal((await readRentalLaunch(h.launch.sessionId))?.state, "stopped");
});

test("grant recovery cannot use superseded success or a queued recovery wake to fence a binding", async (t) => {
  const h = await recoveryFixture(t);
  h.observe("succeeded", false);
  await h.coordinator.recover();
  assert.equal(h.calls.complete, 0);
  h.observe("succeeded");
  const read = h.api.getSession;
  h.api.getSession = async () => { h.observe("pending"); return read(); };
  await h.tick();
  assert.equal(h.calls.complete, 0);
});

for (const fact of ["terminal", "missing", "unsafe", "stopped"] as const) {
  test(`grant recovery does not defer independent ${fact} evidence behind a never-settling grant`, async (t) => {
    const h = await recoveryFixture(t);
    if (fact === "terminal") h.api.getSession = async () => ({ ok: true, status: 200, body: session({ status: "cancelled" }) });
    if (fact === "missing") h.daemon.list = async () => [];
    if (fact === "unsafe") h.entry.permissionProfileId = "full_access";
    if (fact === "stopped") { h.entry.desiredState = "stopped"; h.entry.observedState = "stopped"; }
    await h.coordinator.recover();
    assert.equal((await readRentalLaunch(h.launch.sessionId))?.state, "stopped");
    assert.equal(h.calls.grants, 0);
  });
}

for (const change of ["removed", "attempt", "entry", "room", "stopping"] as const) {
  test(`grant recovery revalidates a ${change} launch after remote reads`, async (t) => {
    const h = await recoveryFixture(t);
    h.observe("succeeded");
    const replacement = { ...h.launch, ...(change === "attempt" ? { launchAttempt: 4 } : {}),
      ...(change === "entry" ? { entryId: "replacement" } : {}), ...(change === "room" ? { roomId: "other" } : {}),
      ...(change === "stopping" ? { state: "stopping" as const } : {}) };
    h.api.getSession = async () => {
      if (change === "removed") await writeFile(h.path, JSON.stringify({ version: 1, entries: {} }));
      else await writeRentalLaunch(replacement);
      return { ok: true, status: 200, body: session({ status: "cancelled" }) };
    };
    await h.coordinator.recover();
    assert.equal(h.calls.complete + h.calls.stop + h.calls.ack, 0);
    assert.deepEqual(await readRentalLaunch(h.launch.sessionId), change === "removed" ? null : replacement);
  });
}

test("grant recovery keeps a healthy exact binding usable during another entry's grant failure", async (t) => {
  const h = await recoveryFixture(t);
  h.entry.agentSessionBindingState = "active";
  h.observe("failed", true, new Error("another grant failed"));
  await assert.rejects(h.coordinator.recover(), /another grant failed/);
  assert.equal(h.calls.refresh, 1);
  assert.equal(h.calls.complete, 0);
  await h.tick();
  assert.equal(h.calls.refresh, 2);
});

test("grant recovery coalesces slow reads but does not lock out explicit teardown", async (t) => {
  const h = await recoveryFixture(t);
  let release!: () => void;
  let signal!: () => void;
  const started = new Promise<void>((resolve) => { signal = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  h.api.getSession = async () => { signal(); await held; return { ok: true, status: 200, body: session({ status: "active" }) }; };
  const recovering = h.coordinator.recover();
  await started;
  const ticks = [h.tick(), h.tick(), h.tick()];
  assert.equal(h.calls.list, 1);
  await h.coordinator.teardown(h.launch.sessionId);
  assert.equal((await readRentalLaunch(h.launch.sessionId))?.state, "stopped");
  release();
  await Promise.all([recovering, ...ticks]);
  assert.equal(h.calls.stop, 1);
  assert.equal(h.calls.ack, 0);
  assert.equal((await readRentalLaunch(h.launch.sessionId))?.state, "stopped");
});

test("grant recovery registers only the first missing owner attempt and existing timer ticks only observe", async (t) => {
  const h = await recoveryFixture(t);
  const get = h.grants.getReconciliationObservation;
  let registered = false;
  h.grants.getReconciliationObservation = () => registered ? get() : null as never;
  h.grants.reconcileDesiredRunning = async () => { h.calls.grants++; registered = true; };
  const periodic = t.mock.method(h.coordinator as unknown as { reconcileActiveSessions(initial?: boolean): Promise<void> }, "reconcileActiveSessions");
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    await h.coordinator.recover();
    for (let i = 0; i < 3; i++) {
      t.mock.timers.tick(30_000);
      await periodic.mock.calls.at(-1)!.result;
    }
    assert.equal(periodic.mock.callCount(), 4);
    assert.equal(h.calls.refresh, 4);
    assert.equal(h.calls.grants, 1);
    assert.equal(h.calls.complete, 0);
  } finally {
    t.mock.timers.reset();
  }
});

test("grant recovery retries a stopping obligation even after the manifest entry is absent", async (t) => {
  const h = await recoveryFixture(t);
  await writeRentalLaunch({ ...h.launch, state: "stopping" });
  h.daemon.list = async () => [];
  await h.coordinator.recover();
  assert.equal(h.calls.complete, 1);
  assert.equal(h.calls.stop, 0);
  assert.equal((await readRentalLaunch(h.launch.sessionId))?.state, "stopped");
});

test("grant recovery treats a failed manifest read as unknown rather than an absent worker", async (t) => {
  const h = await recoveryFixture(t);
  h.observe("succeeded");
  h.daemon.list = async () => { throw new Error("transport unavailable"); };
  await h.coordinator.recover();
  assert.equal(h.calls.complete + h.calls.stop + h.calls.ack, 0);
  assert.deepEqual(await readRentalLaunch(h.launch.sessionId), h.launch);
});

test("grant recovery cannot acknowledge an expired launch while its deadline completion is pending", async (t) => {
  const h = await recoveryFixture(t);
  h.entry.agentSessionBindingState = "active";
  const expired = { ...h.launch, state: "launching" as const, deadlineAt: new Date(Date.now() - 1).toISOString() };
  await writeRentalLaunch(expired);
  let releaseRead!: () => void;
  let readStarted!: () => void;
  let releaseCompletion!: () => void;
  const reading = new Promise<void>((resolve) => { readStarted = resolve; });
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
  h.api.getSession = async () => { readStarted(); await readGate; return { ok: true, status: 200, body: session({ status: "active" }) }; };
  h.api.completeSession = async () => { h.calls.complete++; await completionGate; return { ok: true, status: 200, body: session({ status: "completed" }) }; };
  const deadline = t.mock.method(h.coordinator as unknown as { completeAtDeadline(id: string): Promise<void> }, "completeAtDeadline");
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const recovering = h.coordinator.recover();
  try {
    await reading;
    t.mock.timers.tick(0);
    assert.equal(h.calls.complete, 1);
    releaseRead();
    await recovering;
    assert.equal(h.calls.ack, 0, "pending completion cannot authorize an expired launch to become active");
    assert.deepEqual(await readRentalLaunch(h.launch.sessionId), expired);
  } finally {
    releaseRead();
    releaseCompletion();
    await recovering;
    await Promise.allSettled(deadline.mock.calls.map((call) => call.result));
    t.mock.timers.reset();
  }
  assert.equal((await readRentalLaunch(h.launch.sessionId))?.state, "stopped");
});

for (const completionOk of [true, false]) {
  test(`grant recovery keeps expired deadline teardown independent (completion ${completionOk})`, async (t) => {
    const h = await recoveryFixture(t);
    await writeRentalLaunch({ ...h.launch, deadlineAt: new Date(Date.now() - 1).toISOString() });
    if (!completionOk) h.api.completeSession = async () => ({ ok: false, status: 503, error: "unavailable", body: null }) as never;
    const teardown = t.mock.method(h.coordinator, "teardown");
    const deadline = t.mock.method(h.coordinator as unknown as { completeAtDeadline(id: string): Promise<void> }, "completeAtDeadline");
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    try {
      await h.coordinator.recover();
      t.mock.timers.tick(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(teardown.mock.callCount(), 1);
      await teardown.mock.calls[0]!.result;
      await deadline.mock.calls[0]!.result;
      assert.equal((await readRentalLaunch(h.launch.sessionId))?.state, completionOk ? "stopped" : "stopping");
      assert.equal(h.calls.stop, 1);
      assert.equal(h.calls.grants, 0);
    } finally {
      await Promise.allSettled(deadline.mock.calls.map((call) => call.result));
      t.mock.timers.reset();
    }
  });
}

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "rsess_launch",
    listing_id: "rlist_1",
    room_id: "room_canonical",
    task_title: "Investigate",
    task_prompt: "Inspect the failing flow.",
    status: "accepted",
    launch_attempt: 1,
    policy: {},
    approved_scope: {},
    ...overrides,
  };
}

for (const [name, input] of [
  ["malformed JSON", '{"version":1,"entries":{"unfinished":'],
  ["unsupported version", '{"version":99,"entries":{"unfinished":{"state":"active"}}}'],
  ["array entries", '{"version":1,"entries":[{"state":"active"}]}'],
  ["missing entries", '{"version":1}'],
  ["null document", 'null'],
]) test(`rental journal preserves ${name} and prevents recovery from inventing empty state`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-journal-"));
  const path = join(directory, "launches.json");
  const previous = process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
  process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = path;
  await writeFile(path, input!, { mode: 0o600 });
  let daemonCalls = 0;
  const coordinator = new RentalLaunchCoordinator({} as never, {
    async isMaintenanceHeld() { return false; },
    async list() { daemonCalls++; return []; },
  } as never, {} as never);
  try {
    for (const operation of [
      () => readRentalLaunch("unfinished"), () => listRentalLaunches(), () => pruneRentalLaunches(),
      () => writeRentalLaunch({ sessionId: "new", launchAttempt: 1, entryId: "entry", roomId: "room",
        state: "active", updatedAt: "2026-09-27T00:00:00.000Z" }),
      () => coordinator.recover(),
    ]) {
      await assert.rejects(operation(), /Rental launch journal/);
      assert.equal(await readFile(path, "utf8"), input);
      assert.deepEqual(await readdir(directory), ["launches.json"], "uncertain reads cannot create replacement files");
    }
    assert.equal(daemonCalls, 0, "unknown launch history cannot authorize recovery actions");
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
    else process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = previous;
  }
});

test("rental journal propagates a non-absence read failure without creating a replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-journal-"));
  const path = join(directory, "launches.json");
  const previous = process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
  process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = path;
  await mkdir(path);
  try {
    await assert.rejects(listRentalLaunches(), { code: "EISDIR" });
    await assert.rejects(pruneRentalLaunches(), { code: "EISDIR" });
    assert.deepEqual(await readdir(directory), ["launches.json"]);
    assert.deepEqual(await readdir(path), []);
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
    else process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = previous;
  }
});

test("rental journal initializes only missing state and preserves active deadlines during valid pruning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-journal-"));
  const path = join(directory, "launches.json");
  const previous = process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
  process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = path;
  const active = { sessionId: "active", launchAttempt: 3, entryId: "entry", roomId: "room",
    state: "active" as const, updatedAt: "2026-01-01T00:00:00.000Z", deadlineAt: "2026-10-01T00:00:00.000Z" };
  try {
    assert.equal(await readRentalLaunch("active"), null);
    assert.deepEqual(await listRentalLaunches(), []);
    await Promise.all([writeRentalLaunch(active), writeRentalLaunch({ ...active, sessionId: "old", state: "stopped" })]);
    assert.equal(await pruneRentalLaunches(new Date("2026-09-01T00:00:00.000Z")), 1);
    assert.deepEqual(await listRentalLaunches(), [active]);
    assert.deepEqual(await readRentalLaunch("active"), active);
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
    else process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = previous;
  }
});

test("manual acceptance installs exact rental authority, activates at room tail, and returns no credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-launch-"));
  const previous = process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
  process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = join(directory, "launches.json");
  const calls: Array<{ method: string; input?: Record<string, unknown> }> = [];
  let charter = "";
  const entry = {
    id: "supervised_rental_5fbb5e1c5b61bfe3d38a4aab507a0f11",
    roomId: "room_canonical",
    desiredState: "running",
    observedState: "running",
    condition: "none",
    agentSessionId: "ras_worker",
    agentSessionBindingState: "active" as const,
    readyReachedAt: "2026-08-09T10:00:00.000Z",
  };
  const api = {
    async acceptRequest(_id: string, input: Record<string, unknown>) {
      assert.equal((await readRentalLaunch("rsess_launch"))?.state, "accepting");
      calls.push({ method: "accept", input });
      return { ok: true as const, status: 200, body: session() };
    },
    async requestLaunchAuthority(_id: string, input: Record<string, unknown>) {
      calls.push({ method: "authority", input });
      return { ok: true as const, status: 201, body: {
        session: session(),
        grant: {
          grant_id: "sgrant_rental",
          current_generation: 4,
          token_version: 1,
          expires_at: "2026-08-10T10:00:00.000Z",
          supervisor_grant: "secret-supervisor-bearer",
        },
      } };
    },
    async acknowledgeLaunch(_id: string, input: Record<string, unknown>) {
      calls.push({ method: `ack:${input.state}`, input });
      return { ok: true as const, status: 200, body: session({ status: input.state === "active" ? "active" : "provisioning" }) };
    },
    async getSession() { return { ok: true as const, status: 200, body: session({ status: "active" }) }; },
    async completeSession() { return { ok: true as const, status: 200, body: session({ status: "completed" }) }; },
  };
  const daemon = {
    async isMaintenanceHeld() { return false; },
    async ensureRunning() { return { generation: 99 }; },
    async compareAndSetDesiredState() { return entry; },
    async list() { return [entry]; },
  };
  const grants = {
    async createRentalPausedAndInstall(input: Record<string, unknown>) {
      charter = String(input.charter);
      const prepared = input.preparedGrant as { token: string; metadata: { allowedRoomIds: string[]; allowedAgentKeys: string[] } };
      assert.equal(prepared.token, "secret-supervisor-bearer");
      assert.deepEqual(prepared.metadata.allowedRoomIds, ["room_canonical"]);
      assert.deepEqual(prepared.metadata.allowedAgentKeys, ["agent_rental"]);
      assert.equal(input.repoRootPath, null);
      return { entry, agentKey: "agent_rental" };
    },
  };
  const coordinator = new RentalLaunchCoordinator(
    api as never,
    daemon as never,
    grants as never,
    () => "desktop-host",
    async () => "agent_rental",
    async () => ({ canStart: true, status: "ready" }) as never,
  );

  try {
    const result = await coordinator.acceptAndLaunch("rsess_launch", {
      providerId: "cursor",
      permissionProfileId: "sandboxed_write",
    });
    assert.equal(result.status, "active");
    assert.equal(JSON.stringify(result).includes("secret-supervisor-bearer"), false);
    assert.match(charter, /full room history/);
    assert.match(charter, /Earlier messages are context, not new tasks/);
    assert.deepEqual(calls.map((call) => call.method), [
      "accept", "authority", "ack:provisioning", "ack:active",
    ]);
    assert.equal((calls[0]?.input?.runtime as Record<string, unknown>).kind, "cursor");
    assert.equal((calls[0]?.input?.runtime as Record<string, unknown>).permissionProfileId, "sandboxed_write");
    assert.equal(calls.at(-1)?.input?.roomAgentSessionId, "ras_worker");
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
    else process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = previous;
  }
});

test("launch failure is sanitized, acknowledged, and remains retryable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-launch-"));
  const previous = process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
  process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = join(directory, "launches.json");
  const acknowledgements: Record<string, unknown>[] = [];
  const coordinator = new RentalLaunchCoordinator(
    {
      async acceptRequest() { return { ok: true as const, status: 200, body: session() }; },
      async requestLaunchAuthority() { throw new Error("token=never-print-this"); },
      async acknowledgeLaunch(_id: string, input: Record<string, unknown>) {
        acknowledgements.push(input);
        return { ok: true as const, status: 200, body: session() };
      },
    } as never,
    { async isMaintenanceHeld() { return false; }, async ensureRunning() { return { generation: 1 }; } } as never,
    {} as never,
    () => "host",
    async () => "agent_rental",
    async () => ({ canStart: true, status: "ready" }) as never,
  );
  try {
    await assert.rejects(
      coordinator.acceptAndLaunch("rsess_launch", { providerId: "cursor", permissionProfileId: "sandboxed_write" }),
      /\[REDACTED\]/,
    );
    assert.equal(acknowledgements[0]?.state, "launch_failed");
    assert.equal(String(acknowledgements[0]?.errorMessage).includes("never-print-this"), false);
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
    else process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = previous;
  }
});

test("unsafe or implicit native profiles are rejected before provider acceptance", async () => {
  let accepted = false;
  const coordinator = new RentalLaunchCoordinator(
    {
      async acceptRequest() {
        accepted = true;
        return { ok: true as const, status: 200, body: session() };
      },
    } as never,
    { async isMaintenanceHeld() { return false; } } as never,
    {} as never,
    () => "host",
    async () => "agent_rental",
    async () => ({ canStart: true, status: "ready" }) as never,
  );

  await assert.rejects(
    coordinator.acceptAndLaunch("rsess_launch", {
      providerId: "codex",
      permissionProfileId: "full_access",
    }),
    /verified workspace-rooted rental profile/,
  );
  await assert.rejects(
    coordinator.acceptAndLaunch("rsess_launch", {
      providerId: "cursor",
      permissionProfileId: null,
    }),
    /explicit rental-safe permission profile/,
  );
  assert.equal(accepted, false);
});

test("recovery completes an active server rental when its daemon worker is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-recovery-"));
  const previous = process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
  process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = join(directory, "launches.json");
  let completed = 0;
  let refreshed = 0;
  await writeRentalLaunch({
    sessionId: "rsess_missing",
    launchAttempt: 2,
    entryId: "supervised_rental_missing",
    roomId: "room_canonical",
    state: "active",
    configuration: { providerId: "cursor", permissionProfileId: "sandboxed_write" },
    updatedAt: new Date().toISOString(),
  });
  const coordinator = new RentalLaunchCoordinator(
    {
      async getSession() { refreshed += 1; return { ok: true as const, status: 200, body: session({ status: "active" }) }; },
      async completeSession() { completed += 1; return { ok: true as const, status: 200, body: session({ status: "completed" }) }; },
    } as never,
    { async isMaintenanceHeld() { return false; }, async list() { return []; } } as never,
    restoredGrants as never,
  );
  try {
    await coordinator.recover();
    assert.equal(completed, 1);
    assert.equal(refreshed, 0);
    assert.equal((await readRentalLaunch("rsess_missing"))?.state, "stopped");
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
    else process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = previous;
  }
});

test("recovery fences a historical worker binding instead of treating it as live", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-historical-recovery-"));
  const previous = process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
  process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = join(directory, "launches.json");
  let completed = 0;
  let purged = 0;
  const entry = {
    id: "supervised_rental_historical",
    provider: "cursor",
    permissionProfileId: "sandboxed_write",
    desiredState: "running",
    observedState: "running",
    condition: "none",
    agentSessionId: "ras_old_worker",
    agentSessionBindingState: "historical" as const,
    readyReachedAt: "2026-08-09T10:00:00.000Z",
  };
  await writeRentalLaunch({
    sessionId: "rsess_historical",
    launchAttempt: 3,
    entryId: entry.id,
    roomId: "room_canonical",
    state: "active",
    configuration: { providerId: "cursor", permissionProfileId: "sandboxed_write" },
    updatedAt: new Date().toISOString(),
  });
  const coordinator = new RentalLaunchCoordinator(
    {
      async getSession() { return { ok: true as const, status: 200, body: session({ status: "active" }) }; },
      async completeSession() {
        completed += 1;
        return { ok: true as const, status: 200, body: session({ status: "completed" }) };
      },
    } as never,
    {
      async list() { return [entry]; },
      async setDesiredState() {
        entry.desiredState = "stopped";
        entry.observedState = "stopped";
        return entry;
      },
      async isMaintenanceHeld() { return false; },
      async ensureRunning() { return { generation: 1 }; },
      async purgeAgent() { purged += 1; return { outcome: "purged" }; },
    } as never,
    restoredGrants as never,
  );
  try {
    await coordinator.recover();
    assert.equal(completed, 1);
    assert.equal(purged, 1);
    assert.equal((await readRentalLaunch("rsess_historical"))?.state, "stopped");
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
    else process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = previous;
  }
});

test("one malformed recovered launch does not stop reconciliation of the others", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-isolated-recovery-"));
  const previous = process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
  process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = join(directory, "launches.json");
  const entry = (id: string) => ({
    id,
    provider: "cursor",
    permissionProfileId: "sandboxed_write",
    desiredState: "running",
    observedState: "running",
    condition: "none",
    agentSessionId: `ras_${id}`,
    agentSessionBindingState: "active" as const,
    readyReachedAt: "2026-08-09T10:00:00.000Z",
  });
  const bad = entry("supervised_rental_bad");
  const good = entry("supervised_rental_good");
  for (const [sessionId, current] of [["rsess_bad", bad], ["rsess_good", good]] as const) {
    await writeRentalLaunch({
      sessionId,
      launchAttempt: 1,
      entryId: current.id,
      roomId: "room_canonical",
      state: "active",
      configuration: { providerId: "cursor", permissionProfileId: "sandboxed_write" },
      updatedAt: new Date().toISOString(),
    });
  }
  let goodRefreshes = 0;
  const coordinator = new RentalLaunchCoordinator(
    {
      async getSession(id: string) {
        if (id === "rsess_bad") return { ok: true as const, status: 200, body: { malformed: true } };
        goodRefreshes += 1;
        return { ok: true as const, status: 200, body: session({ id, status: "active" }) };
      },
    } as never,
    { async isMaintenanceHeld() { return false; }, async list() { return [bad, good]; } } as never,
    restoredGrants as never,
  );
  try {
    await coordinator.recover();
    assert.equal(goodRefreshes, 1);
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
    else process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = previous;
  }
});

test("a lost active acknowledgement response is recovered without purging the worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-active-ack-"));
  const previous = process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
  process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = join(directory, "launches.json");
  const entry = {
    id: "supervised_rental_5fbb5e1c5b61bfe3d38a4aab507a0f11",
    roomId: "room_canonical",
    desiredState: "running",
    observedState: "running",
    condition: "none",
    agentSessionId: "ras_worker",
    agentSessionBindingState: "active" as const,
    readyReachedAt: "2026-08-09T10:00:00.000Z",
  };
  const acknowledgementStates: unknown[] = [];
  let purged = 0;
  const coordinator = new RentalLaunchCoordinator(
    {
      async acceptRequest() { return { ok: true as const, status: 200, body: session() }; },
      async requestLaunchAuthority() {
        return { ok: true as const, status: 201, body: {
          grant: {
            grant_id: "sgrant_rental",
            current_generation: 1,
            expires_at: "2026-08-10T10:00:00.000Z",
            supervisor_grant: "secret",
          },
        } };
      },
      async acknowledgeLaunch(_id: string, input: Record<string, unknown>) {
        acknowledgementStates.push(input.state);
        if (input.state === "active") {
          return { ok: false as const, status: 0, error: "socket_closed", body: null };
        }
        return { ok: true as const, status: 200, body: session({ status: "provisioning" }) };
      },
      async getSession() {
        return { ok: true as const, status: 200, body: session({
          status: "active",
          launch_state: "active",
          daemon_entry_id: entry.id,
          room_agent_session_id: entry.agentSessionId,
        }) };
      },
    } as never,
    {
      async isMaintenanceHeld() { return false; },
      async ensureRunning() { return { generation: 1 }; },
      async compareAndSetDesiredState() { return entry; },
      async list() { return [entry]; },
      async purgeAgent() { purged += 1; return { outcome: "purged" }; },
    } as never,
    {
      async createRentalPausedAndInstall() { return { entry, agentKey: "agent_rental" }; },
    } as never,
    () => "desktop-host",
    async () => "agent_rental",
    async () => ({ canStart: true, status: "ready" }) as never,
  );
  try {
    const result = await coordinator.acceptAndLaunch("rsess_launch", {
      providerId: "cursor",
      permissionProfileId: "sandboxed_write",
    });
    assert.equal(result.status, "active");
    assert.deepEqual(acknowledgementStates, ["provisioning", "active"]);
    assert.equal(purged, 0);
    assert.equal((await readRentalLaunch("rsess_launch"))?.state, "active");
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
    else process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = previous;
  }
});

test("recovery resumes a durable pre-accept intent instead of stranding capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-accept-recovery-"));
  const previous = process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
  process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = join(directory, "launches.json");
  let accepted = 0;
  await writeRentalLaunch({
    sessionId: "rsess_accepting",
    launchAttempt: 0,
    entryId: "supervised_rental_accepting",
    roomId: "",
    state: "accepting",
    configuration: { providerId: "cursor", permissionProfileId: "sandboxed_write" },
    updatedAt: new Date().toISOString(),
  });
  const coordinator = new RentalLaunchCoordinator(
    {
      async acceptRequest() {
        accepted += 1;
        return { ok: false as const, status: 400, error: "request_expired", body: null };
      },
    } as never,
    { async isMaintenanceHeld() { return false; }, async list() { return []; } } as never,
    restoredGrants as never,
    () => "host",
    async () => "agent_rental",
    async () => ({ canStart: true, status: "ready" }) as never,
  );
  try {
    await coordinator.recover();
    assert.equal(accepted, 1);
    assert.equal((await readRentalLaunch("rsess_accepting"))?.state, "failed");
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
    else process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = previous;
  }
});

test("recovery arms a persisted hard deadline before daemon or API connectivity", { timeout: 5_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-rental-deadline-recovery-"));
  const previous = process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
  process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = join(directory, "launches.json");
  const entry = {
    id: "supervised_rental_deadline",
    desiredState: "stopped",
    observedState: "stopped",
    condition: "none",
  };
  let listCalls = 0;
  let completions = 0;
  let stops = 0;
  await writeRentalLaunch({
    sessionId: "rsess_deadline",
    launchAttempt: 1,
    entryId: entry.id,
    roomId: "room_canonical",
    state: "active",
    deadlineAt: new Date(Date.now() - 100).toISOString(),
    configuration: { providerId: "cursor", permissionProfileId: "sandboxed_write" },
    updatedAt: new Date().toISOString(),
  });
  const coordinator = new RentalLaunchCoordinator(
    {
      async completeSession() {
        completions += 1;
        return { ok: true as const, status: 200, body: session({ status: "completed" }) };
      },
    } as never,
    {
      async list() {
        listCalls += 1;
        if (listCalls === 1) throw new Error("daemon temporarily unavailable");
        return [entry];
      },
      async setDesiredState() { stops += 1; return entry; },
      async isMaintenanceHeld() { return false; },
      async ensureRunning() { return { generation: 1 }; },
      async purgeAgent() { return { outcome: "purged" }; },
    } as never,
    restoredGrants as never,
  );
  const teardown = t.mock.method(coordinator, "teardown");
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    await coordinator.recover();
    t.mock.timers.tick(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(teardown.mock.callCount(), 1, "the expired deadline initiates teardown despite daemon recovery failure");
    await teardown.mock.calls[0]!.result;
    assert.equal(completions, 1);
    assert.equal(stops, 1);
    assert.equal((await readRentalLaunch("rsess_deadline"))?.state, "stopped");
  } finally {
    await Promise.allSettled(teardown.mock.calls.map((call) => call.result));
    t.mock.timers.reset();
    if (previous === undefined) delete process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
    else process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = previous;
  }
});


test("maintenance blocks rental admission and reclassification while durable deadlines still complete", async (t) => {
  const h = await recoveryFixture(t); h.daemon.isMaintenanceHeld = async () => true;
  h.daemon.setDesiredState = async () => { throw new Error("maintenance"); };
  await assert.rejects(h.coordinator.acceptAndLaunch("new", { providerId: "cursor", permissionProfileId: "sandboxed_write" }), /maintenance/);
  await h.coordinator.recover(); await h.tick();
  assert.deepEqual(await readRentalLaunch(h.launch.sessionId), h.launch);
  assert.deepEqual(h.calls, { grants: 0, complete: 0, stop: 0, purge: 0, refresh: 0, ack: 0, list: 0 });
  await writeRentalLaunch({ ...h.launch, deadlineAt: new Date(Date.now() - 1).toISOString() });
  const deadline = t.mock.method(h.coordinator as unknown as { completeAtDeadline(id: string): Promise<void> }, "completeAtDeadline");
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    await h.tick(); t.mock.timers.tick(0);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(deadline.mock.callCount(), 1); await deadline.mock.calls[0]!.result;
    assert.equal(h.calls.complete, 1); assert.equal(h.calls.ack, 0); assert.equal(h.calls.grants, 0);
    assert.equal((await readRentalLaunch(h.launch.sessionId))?.state, "stopping", "blocked local cleanup must not report stopped");
  } finally { await Promise.allSettled(deadline.mock.calls.map(c => c.result)); t.mock.timers.reset(); }
});


test("maintenance fences rental acceptance when an earlier preflight finishes late", async t => {
  const h = await recoveryFixture(t); let held = false; let finish!: () => void; let started!: () => void;
  const gate = new Promise<void>(r => { finish = r; }); const entered = new Promise<void>(r => { started = r; });
  h.daemon.isMaintenanceHeld = async () => held;
  const coordinator = new RentalLaunchCoordinator({ acceptRequest: async () => assert.fail("late rental acceptance") } as never, h.daemon as never, h.grants as never,
    () => "inert-host", async () => assert.fail("late identity"), async () => { started(); await gate; return { canStart: true, status: "ready" } as never; });
  const operation = coordinator.acceptAndLaunch("late", { providerId: "cursor", permissionProfileId: "sandboxed_write" });
  await entered; held = true; finish();
  await assert.rejects(operation, /maintenance/);
  assert.equal(await readRentalLaunch("late"), null);
});

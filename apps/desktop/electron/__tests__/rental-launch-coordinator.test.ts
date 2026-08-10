import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RentalLaunchCoordinator } from "../rental/launch-coordinator.js";
import { readRentalLaunch, writeRentalLaunch } from "../rental/launch-journal.js";

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
    { async ensureRunning() { return { generation: 1 }; } } as never,
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
    {} as never,
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
    { async list() { return []; } } as never,
    {} as never,
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
      async ensureRunning() { return { generation: 1 }; },
      async purgeAgent() { purged += 1; return { outcome: "purged" }; },
    } as never,
    {} as never,
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
    { async list() { return [bad, good]; } } as never,
    {} as never,
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
    { async list() { return []; } } as never,
    {} as never,
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

test("recovery arms a persisted hard deadline before daemon or API connectivity", async () => {
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
      async ensureRunning() { return { generation: 1 }; },
      async purgeAgent() { return { outcome: "purged" }; },
    } as never,
    {} as never,
  );
  try {
    await coordinator.recover();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(completions, 1);
    assert.equal(stops, 1);
    assert.equal((await readRentalLaunch("rsess_deadline"))?.state, "stopped");
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH;
    else process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH = previous;
  }
});

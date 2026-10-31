import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DaemonActivityWrites } from "../activity-write-batcher.js";
import { DaemonAuthority } from "../daemon-authority.js";
import { ManifestStore, type ActivityWrite } from "../manifest-store.js";
import { RecentActivityWindows } from "../recent-activity-windows.js";
import type { DaemonActivityEvent, DaemonManifestEntry } from "../types.js";

function agent(id: string): DaemonManifestEntry {
  return {
    id, room_id: "room_1", display_name: `Agent ${id}`, provider: "codex", model: "gpt-5.6-codex",
    charter: "Work on the room's tasks.", desired_state: "running", observed_state: "idle",
    condition: "none", last_error: null, permission_profile_id: "workspace-write",
    provider_launch_policy: { deliveryMode: "mcp_polling" }, created_by: "user_1",
    created_at: "2026-10-19T00:00:00.000Z", source_repo_path: "/repo", workspace_path: `/worktrees/${id}`,
    work_attempt_id: `attempt_${id}`,
    workplace_liveness: { state: "reachable", observed_at: "2026-10-19T00:01:00.000Z", detail: null },
    native_liveness: { state: "unknown", observed_at: null, detail: null },
    activity: [],
  } as DaemonManifestEntry;
}

function event(sequence: number, extra: Partial<DaemonActivityEvent> = {}): DaemonActivityEvent {
  return {
    observed_at: new Date(1_800_000_000_000 + sequence).toISOString(), sequence, provider: "codex", kind: "tool",
    method: "item/commandExecution", summary: `step ${sequence}`, status: "working",
    payload: { step: sequence, output: "x".repeat(sequence % 7), nested: { list: [sequence, null, true] } },
    payload_truncated: false, payload_redacted: false, durable_payload_ref: null, ...extra,
  };
}

function write(agentId: string, sequence: number, limit = 200, extra: Partial<DaemonActivityEvent> = {}): ActivityWrite {
  return { agentId, event: event(sequence, extra), runtimeUpdate: null, limit };
}

async function harness(maxBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), "letagents-recent-activity-"));
  const store = new ManifestStore(join(root, "daemon-state.sqlite"));
  let generation = (await store.write(0, [agent("a"), agent("b")])).generation;
  // Full reads the windows make; the tests' own reference reads are not counted.
  let fullReads = 0;
  const counted = {
    getEntry: (agentId: string, mode?: "full" | "summary") => { fullReads += 1; return store.getEntry(agentId, mode); },
    getEntrySummaryWithActivityShape: (agentId: string) => store.getEntrySummaryWithActivityShape(agentId),
  };
  let pending: DaemonActivityEvent[] = [];
  const overlay = <T extends DaemonManifestEntry | undefined>(entry: T): T => (entry && pending.length
    ? { ...entry, activity: [...(entry.activity ?? []), ...pending].slice(-200) } : entry);
  const windows = new RecentActivityWindows({ store: counted, overlay, ...(maxBytes ? { maxBytes } : {}) });
  return {
    store, windows,
    get fullReads() { return fullReads; },
    setPending(events: DaemonActivityEvent[]) { pending = events; },
    async commit(items: ActivityWrite[]) {
      const next = await store.recordActivityBatch(generation, items);
      generation = next.generation;
      windows.committed(next.events);
      return next;
    },
    async expectSame(agentId: string) {
      const read = await windows.read(agentId);
      assert.deepEqual(read, overlay(await store.getEntry(agentId)));
      return read;
    },
    get generation() { return generation; },
    set generation(value: number) { generation = value; },
    cleanup: async () => { await store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("committed batches keep the window current without another full read", async () => {
  const h = await harness();
  try {
    await h.expectSame("a");
    assert.equal(h.fullReads, 1, "the window is seeded by one full read");
    for (let sequence = 1; sequence <= 30; sequence += 1) {
      await h.commit([write("a", sequence), write("b", sequence)]);
      await h.expectSame("a");
    }
    // Every later read is answered from the window.
    assert.equal(h.fullReads, 1);
  } finally {
    await h.cleanup();
  }
});

test("the window trims to the write limit as the store does, and adds the pending overlay", async () => {
  const h = await harness();
  try {
    await h.expectSame("a");
    for (let sequence = 1; sequence <= 230; sequence += 10) {
      await h.commit(Array.from({ length: 10 }, (_, index) => write("a", sequence + index)));
    }
    const read = await h.expectSame("a");
    assert.equal(read?.activity?.length, 200);
    assert.equal(read?.activity?.[0]?.sequence, 31);
    const before = h.fullReads;
    h.setPending([event(231), event(232)]);
    const withPending = await h.expectSame("a");
    assert.deepEqual(withPending?.activity?.slice(-2).map((item) => item.sequence), [231, 232]);
    assert.equal(h.fullReads, before, "answered from the window");
  } finally {
    await h.cleanup();
  }
});

test("a write that bypasses the batches is found and answered with a full read", async () => {
  const h = await harness();
  try {
    await h.commit([write("a", 1), write("a", 2)]);
    await h.expectSame("a");
    // A turn notice or another writer: appended without the windows.
    h.generation = (await h.store.recordActivity(h.generation, "a", event(3), null, 200)).generation;
    let before = h.fullReads;
    await h.expectSame("a");
    assert.equal(h.fullReads, before + 1, "one fallback full read");

    // The entry replaced: same count, first sequence and newest 16 events,
    // but an older event differs. Only the sum of sequences shows it.
    const replace = async (activity: DaemonActivityEvent[]) => {
      h.generation = (await h.store.write(h.generation, [{ ...(await h.store.getEntry("a"))!, activity },
        (await h.store.getEntry("b"))!])).generation;
    };
    await replace(Array.from({ length: 20 }, (_, index) => event(index + 1)));
    await h.expectSame("a");
    before = h.fullReads;
    await replace(Array.from({ length: 20 }, (_, index) => event(index === 2 ? 2 : index + 1)));
    const read = await h.expectSame("a");
    assert.deepEqual(read?.activity?.slice(0, 4).map((item) => item.sequence), [1, 2, 2, 4]);
    assert.equal(h.fullReads, before + 1);

    // Same shape, but one of the newest events changed a stored field.
    before = h.fullReads;
    await replace(Array.from({ length: 20 }, (_, index) => event(index === 2 ? 2 : index + 1, index === 18 ? { status: "idle" } : {})));
    assert.equal((await h.expectSame("a"))?.activity?.[18]?.status, "idle");
    assert.equal(h.fullReads, before + 1);
  } finally {
    await h.cleanup();
  }
});

test("a full read that already holds a committed event is not extended twice", async () => {
  const h = await harness();
  try {
    await h.expectSame("a");
    const next = await h.store.recordActivityBatch(h.generation, [write("a", 1)]);
    h.generation = next.generation;
    // The window is rebuilt from a read after the commit, then the commit
    // reports its events.
    h.windows.forget("a");
    await h.expectSame("a");
    h.windows.committed(next.events);
    const before = h.fullReads;
    await h.expectSame("a");
    assert.equal(h.fullReads, before, "the window still matches");
  } finally {
    await h.cleanup();
  }
});

test("window events are frozen and the window is dropped for a missing entry", async () => {
  const h = await harness();
  try {
    await h.commit([write("a", 1)]);
    const read = await h.windows.read("a");
    assert.throws(() => { (read!.activity![0]!.payload as { step: number }).step = 9; }, TypeError);
    assert.equal(await h.windows.read("missing"), undefined);
    assert.equal(h.windows.size, 1);
  } finally {
    await h.cleanup();
  }
});

test("the least recently read windows are dropped past the byte limit", async () => {
  const h = await harness(2_000);
  try {
    await h.commit(Array.from({ length: 6 }, (_, index) => write("a", index + 1)));
    await h.commit(Array.from({ length: 6 }, (_, index) => write("b", index + 1)));
    await h.windows.read("a");
    await h.windows.read("b");
    assert.equal(h.windows.size, 1, "two windows do not fit");
    await h.expectSame("a");
    await h.expectSame("b");
  } finally {
    await h.cleanup();
  }
});

test("DaemonActivityWrites reads the same entry as overlayEntry, before and after its batches commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-recent-activity-daemon-"));
  const store = new ManifestStore(join(root, "daemon-state.sqlite"));
  try {
    const written = await store.write(0, [agent("a")]);
    const authority = new DaemonAuthority({ assertCurrent: async () => {}, isHandoffScheduled: () => false, notifyStateChanged: () => {} },
      written.generation);
    const writes = new DaemonActivityWrites({ authority, store, isHandoffScheduled: () => false,
      admittedFence: (commit) => authority.fenceDaemonCommit(commit), warn: () => {} });
    const same = async () => {
      const recent = await writes.readRecentEntry("a");
      assert.deepEqual(recent, await writes.overlayEntry(store.getEntry("a")));
    };
    await same();
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      await writes.admission.serializeAdmission(async () => writes.admission.admit(write("a", sequence)));
      await same();
    }
    await writes.flush();
    await same();
    // A retiring daemon's provider birth checkpoint writes outside the lane.
    writes.retireEntry("a");
    await same();
    await writes.close();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

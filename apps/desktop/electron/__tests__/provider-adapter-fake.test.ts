import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderAdapter,
  ProviderAdapterCapabilities,
  ProviderContinuationRef,
  ProviderHandle,
  ProviderObservedState,
  ProviderSpawnRequest,
  ProviderTerminalPayload,
} from "../main/agents/provider-adapter.js";

// In-memory fake child implementing the ProviderAdapter launcher boundary
// (v10 §4.8). It has no real process — it exists to prove the durability
// lifecycle contract (spawn → kill → restart/resume → terminal ordering)
// deterministically, with no live provider and no owner auth (RiverRiver's
// msg_707 clearance). Concrete Codex/Claude/Cursor adapters implement the same
// interface over their native harnesses.
class FakeProviderAdapter implements ProviderAdapter {
  readonly id = "codex" as const;
  private seq = 0;
  private live = new Map<string, FakeHandle>();
  private exitListeners = new Map<string, Set<(p: ProviderTerminalPayload) => void>>();
  constructor(private readonly caps: ProviderAdapterCapabilities) {}

  capabilities(): ProviderAdapterCapabilities {
    return this.caps;
  }

  async spawn(req: ProviderSpawnRequest): Promise<ProviderHandle> {
    // Resume continues the SAME continuation id; a fresh spawn mints a new one.
    const continuationId =
      req.resumeFrom && this.caps.resume
        ? req.resumeFrom.providerContinuationId
        : `codex-thread-${++this.seq}`;
    const handle = new FakeHandle(req.workAttemptId, 40000 + this.seq, continuationId);
    this.live.set(req.workAttemptId, handle);
    return handle;
  }

  async attach(ref: ProviderContinuationRef): Promise<ProviderHandle | null> {
    const handle = this.live.get(ref.workAttemptId);
    if (!handle || handle.observedState() === "failed" || handle.observedState() === "stopped") {
      return null;
    }
    return handle;
  }

  async resume(ref: ProviderContinuationRef, req: ProviderSpawnRequest): Promise<ProviderHandle> {
    if (!this.caps.resume) throw new Error("resume not supported by this adapter");
    return this.spawn({ ...req, resumeFrom: ref });
  }

  async poke(handle: ProviderHandle, _message: string): Promise<void> {
    if (!this.caps.midTurnInjection) throw new Error("poke not supported by this adapter");
    if (this.live.get(handle.workAttemptId) !== handle) throw new Error("stale handle");
  }

  async stop(handle: ProviderHandle, opts?: { force?: boolean }): Promise<ProviderTerminalPayload> {
    const h = handle as FakeHandle;
    const payload = h.terminate(opts?.force ? "killed" : "stopped");
    this.live.delete(h.workAttemptId);
    this.emitExit(h, payload);
    return payload;
  }

  onExit(handle: ProviderHandle, listener: (p: ProviderTerminalPayload) => void): () => void {
    const set = this.exitListeners.get(handle.workAttemptId) ?? new Set();
    set.add(listener);
    this.exitListeners.set(handle.workAttemptId, set);
    return () => set.delete(listener);
  }

  // Test-only: simulate an unexpected crash (kill -9 from outside our control).
  crash(handle: ProviderHandle): ProviderTerminalPayload {
    const h = handle as FakeHandle;
    const payload = h.terminate("crashed");
    this.live.delete(h.workAttemptId);
    this.emitExit(h, payload);
    return payload;
  }

  private emitExit(handle: FakeHandle, payload: ProviderTerminalPayload) {
    for (const l of this.exitListeners.get(handle.workAttemptId) ?? []) l(payload);
  }
}

class FakeHandle implements ProviderHandle {
  private state: ProviderObservedState = "working";
  constructor(
    readonly workAttemptId: string,
    readonly pid: number | null,
    readonly providerContinuationId: string | null
  ) {}
  observedState(): ProviderObservedState {
    return this.state;
  }
  terminate(cause: "killed" | "stopped" | "crashed"): ProviderTerminalPayload {
    this.state = cause === "stopped" ? "stopped" : "failed";
    return {
      endedAt: "2026-07-14T00:00:00.000Z",
      exitCode: cause === "stopped" ? 0 : null,
      signal: cause === "killed" || cause === "crashed" ? "SIGKILL" : null,
      terminalCause: cause,
      providerContinuationId: this.providerContinuationId,
    };
  }
}

const fullCaps: ProviderAdapterCapabilities = {
  resume: true,
  midTurnInjection: true,
  transcriptAccess: true,
  permissionPromptBridging: true,
  survivesRestart: true,
};

test("spawn yields a working handle with a fresh continuation id", async () => {
  const a = new FakeProviderAdapter(fullCaps);
  const h = await a.spawn({ workAttemptId: "wa_1", roomId: "room_1", cwd: "/tmp/wa_1", launchPolicy: { mode: "ask" } });
  assert.equal(h.observedState(), "working");
  assert.ok(h.providerContinuationId);
  assert.equal(await a.attach({ workAttemptId: "wa_1", providerContinuationId: h.providerContinuationId! }) !== null, true);
});

test("crash fires onExit with a terminal payload and attach then returns null", async () => {
  const a = new FakeProviderAdapter(fullCaps);
  const h = await a.spawn({ workAttemptId: "wa_2", roomId: "room_1", cwd: "/tmp/wa_2", launchPolicy: {} });
  let seen: ProviderTerminalPayload | null = null;
  a.onExit(h, (p) => { seen = p; });
  a.crash(h);
  assert.equal(seen!.terminalCause, "crashed");
  assert.equal(seen!.providerContinuationId, h.providerContinuationId);
  assert.equal(await a.attach({ workAttemptId: "wa_2", providerContinuationId: h.providerContinuationId! }), null);
});

test("resume continues the SAME session (durability), a fresh spawn does not", async () => {
  const a = new FakeProviderAdapter(fullCaps);
  const first = await a.spawn({ workAttemptId: "wa_3", roomId: "room_1", cwd: "/tmp/wa_3", launchPolicy: {} });
  const cont = first.providerContinuationId!;
  a.crash(first);
  const resumed = await a.resume(
    { workAttemptId: "wa_3", providerContinuationId: cont },
    { workAttemptId: "wa_3", roomId: "room_1", cwd: "/tmp/wa_3", launchPolicy: {} }
  );
  assert.equal(resumed.providerContinuationId, cont, "resume kept the same thread");
  const fresh = await a.spawn({ workAttemptId: "wa_3b", roomId: "room_1", cwd: "/tmp/wa_3b", launchPolicy: {} });
  assert.notEqual(fresh.providerContinuationId, cont, "a fresh spawn mints a new thread");
});

test("stop returns an ordered terminal payload and no-resume adapter refuses resume (bounded recovery)", async () => {
  const a = new FakeProviderAdapter(fullCaps);
  const h = await a.spawn({ workAttemptId: "wa_4", roomId: "room_1", cwd: "/tmp/wa_4", launchPolicy: {} });
  let exits = 0;
  a.onExit(h, () => { exits++; });
  const payload = await a.stop(h);
  assert.equal(payload.terminalCause, "stopped");
  assert.equal(payload.exitCode, 0);
  assert.equal(exits, 1, "onExit fired exactly once on stop");

  const noResume = new FakeProviderAdapter({ ...fullCaps, resume: false, survivesRestart: false });
  const h2 = await noResume.spawn({ workAttemptId: "wa_5", roomId: "room_1", cwd: "/tmp/wa_5", launchPolicy: {} });
  noResume.crash(h2);
  await assert.rejects(
    noResume.resume({ workAttemptId: "wa_5", providerContinuationId: h2.providerContinuationId! }, { workAttemptId: "wa_5", roomId: "room_1", cwd: "/tmp/wa_5", launchPolicy: {} }),
    /resume not supported/
  );
});

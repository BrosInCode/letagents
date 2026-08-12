import assert from "node:assert/strict";
import test from "node:test";

import { synthesizeTerminalPayload } from "../main/agents/provider-adapter.js";
import type { ProviderTerminalCause } from "../main/agents/provider-adapter.js";

// task_28 cell (d): raw SIGKILL leaves no native terminal payload, so the
// adapter derives one from the observed OS exit. These assert the code/signal →
// cause mapping, and that `stopRequested` distinguishes an intended stop from an
// unexpected death.
const cases: Array<{
  name: string;
  input: { exitCode: number | null; signal: string | null; stopRequested?: boolean };
  cause: ProviderTerminalCause;
}> = [
  { name: "clean exit, not requested", input: { exitCode: 0, signal: null }, cause: "exited" },
  { name: "clean exit during a requested stop", input: { exitCode: 0, signal: null, stopRequested: true }, cause: "stopped" },
  { name: "SIGTERM we sent (graceful stop)", input: { exitCode: null, signal: "SIGTERM", stopRequested: true }, cause: "stopped" },
  { name: "SIGTERM we did NOT send (external)", input: { exitCode: null, signal: "SIGTERM" }, cause: "crashed" },
  { name: "SIGKILL we sent (force stop)", input: { exitCode: null, signal: "SIGKILL", stopRequested: true }, cause: "killed" },
  { name: "SIGKILL from outside (kill -9 / OOM) — cell (d)", input: { exitCode: null, signal: "SIGKILL" }, cause: "crashed" },
  { name: "nonzero exit, unexpected", input: { exitCode: 1, signal: null }, cause: "crashed" },
  { name: "nonzero exit during requested stop", input: { exitCode: 1, signal: null, stopRequested: true }, cause: "stopped" },
  { name: "died with neither code nor signal", input: { exitCode: null, signal: null }, cause: "crashed" },
  { name: "unknown terminating signal", input: { exitCode: null, signal: "SIGSEGV" }, cause: "crashed" },
];

for (const c of cases) {
  test(`synthesizeTerminalPayload: ${c.name} → ${c.cause}`, () => {
    const payload = synthesizeTerminalPayload({
      ...c.input,
      providerContinuationId: "codex-thread-1",
      endedAt: "2026-07-14T00:00:00.000Z",
    });
    assert.equal(payload.terminalCause, c.cause);
    assert.equal(payload.exitCode, c.input.exitCode);
    assert.equal(payload.signal, c.input.signal);
    // The observed payload always carries the continuation id + timestamp verbatim.
    assert.equal(payload.providerContinuationId, "codex-thread-1");
    assert.equal(payload.endedAt, "2026-07-14T00:00:00.000Z");
  });
}

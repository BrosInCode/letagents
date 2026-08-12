import assert from "node:assert/strict";
import test from "node:test";

import { createTrailingSingleFlight } from "../single-flight.js";

test("a request in the completion/finally window always gets a trailing pass", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let passes = 0;
  const refresh = createTrailingSingleFlight(async () => {
    passes += 1;
    if (passes === 1) await firstGate;
  });

  const first = refresh();
  releaseFirst();
  let second!: Promise<void>;
  queueMicrotask(() => { second = refresh(); });
  const firstOutcome = await first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const secondOutcome = await second;
  assert.equal(passes, 2);
  assert.equal(firstOutcome.coalesced, false);
  assert.equal(secondOutcome.coalesced, false);
});

test("bursts during one pass coalesce into exactly one trailing pass", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let passes = 0;
  const refresh = createTrailingSingleFlight(async () => {
    passes += 1;
    if (passes === 1) await firstGate;
  });

  const first = refresh();
  const trailing = [refresh(), refresh(), refresh()];
  releaseFirst();
  const outcomes = await Promise.all([first, ...trailing]);
  assert.equal(passes, 2);
  assert.equal(outcomes[0]?.coalesced, false);
  assert.ok(outcomes.slice(1).some((outcome) => outcome.coalesced));
});

test("a failed generation rejects its callers and later requests can retry", async () => {
  let passes = 0;
  const refresh = createTrailingSingleFlight(async () => {
    passes += 1;
    if (passes === 1) throw new Error("transient");
  });
  await assert.rejects(refresh(), /transient/);
  await refresh();
  assert.equal(passes, 2);
});

test("state raised during an active pass is consumed by the trailing pass", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let includeOwnerLeases = false;
  const observed: boolean[] = [];
  const refresh = createTrailingSingleFlight(async () => {
    const includeForThisPass = includeOwnerLeases;
    includeOwnerLeases = false;
    observed.push(includeForThisPass);
    if (observed.length === 1) await firstGate;
  });

  const first = refresh();
  includeOwnerLeases = true;
  const trailing = refresh();
  releaseFirst();
  await Promise.all([first, trailing]);

  assert.deepEqual(observed, [false, true]);
});

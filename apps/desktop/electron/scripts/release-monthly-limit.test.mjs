import assert from "node:assert/strict";
import test from "node:test";

import { checkDesktopReleaseLimit } from "./release-monthly-limit.mjs";

const api = "https://api.github.com/repos/BrosInCode/letagents/actions";
const current = { id: 1000, run_attempt: 1, workflow_id: 7, run_started_at: "2026-10-06T10:00:00Z" };
const run = (id, overrides = {}) => ({
  ...current, id, run_started_at: "2026-10-02T10:00:00Z", conclusion: "success", ...overrides,
});

function fixture({ runs = [], anchor = current, attempts = {}, overrides = {} } = {}) {
  const calls = [];
  const routes = {
    [`/runs/${anchor.id}/attempts/${anchor.run_attempt}`]: anchor,
    ...attempts,
    ...overrides,
  };
  const check = () => checkDesktopReleaseLimit({
    repository: "BrosInCode/letagents",
    token: "test-token",
    runId: String(anchor.id),
    runAttempt: String(anchor.run_attempt),
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.Authorization, "Bearer test-token");
      assert.ok(url.startsWith(api));
      const path = url.slice(api.length);
      calls.push(path);
      const page = path.match(/^\/workflows\/7\/runs\?per_page=100&page=(\d+)$/)?.[1];
      const data = Object.hasOwn(routes, path) ? routes[path]
        : page ? { workflow_runs: runs.slice((Number(page) - 1) * 100, Number(page) * 100) }
          : undefined;
      assert.notEqual(data, undefined, `Unexpected API call: ${path}`);
      if (data instanceof Error) throw data;
      return { ok: !data.httpError, status: data.httpError ?? 200, json: async () => data };
    },
  });
  return { check, calls };
}

test("the tenth workflow attempt is allowed and the eleventh is blocked, regardless of outcome", async () => {
  const prior = Array.from({ length: 9 }, (_, index) => run(index + 1, {
    conclusion: ["success", "failure", "cancelled"][index % 3],
  }));
  const tenth = fixture({ runs: [...prior, current] });
  assert.deepEqual(await tenth.check(), {
    allowed: true, used: 10, limit: 10, month: "2026-10", resetsAt: "2026-11-01 00:00 Africa/Lagos",
  });
  // Each matrix job observes the same attempt, rather than consuming another slot.
  assert.equal((await tenth.check()).used, 10);
  const eleventh = await fixture({ runs: [...prior, run(10), current] }).check();
  assert.equal(eleventh.allowed, false);
  assert.equal(eleventh.used, 11);
});

test("retrying a workflow or a single failed job consumes another attempt", async () => {
  const anchor = { ...current, run_attempt: 2 };
  const firstAttempt = { ...current, run_started_at: "2026-10-05T10:00:00Z" };
  const result = await fixture({
    anchor,
    runs: [...Array.from({ length: 9 }, (_, i) => run(i + 1)), anchor],
    attempts: { "/runs/1000/attempts/1": firstAttempt },
  }).check();
  assert.equal(result.allowed, false);
  assert.equal(result.used, 11);
});

test("retries of older tags count in the month when each attempt starts", async () => {
  const historical = run(5, { run_attempt: 3, created_at: "2026-09-01T10:00:00Z" });
  const result = await fixture({
    runs: [current, historical],
    attempts: {
      "/runs/5/attempts/2": run(5, { run_attempt: 2, run_started_at: "2026-10-01T01:00:00Z" }),
      "/runs/5/attempts/1": run(5, { run_started_at: "2026-09-01T10:00:00Z" }),
    },
  }).check();
  assert.equal(result.used, 3);
});

test("the Lagos month boundary excludes September but includes October before UTC midnight", async () => {
  const result = await fixture({ runs: [
    run(1, { run_started_at: "2026-09-30T22:59:59Z" }),
    run(2, { run_started_at: "2026-09-30T23:00:00Z" }),
  ] }).check();
  assert.equal(result.used, 2);
  const anchor = { ...current, run_started_at: "2026-12-31T23:00:00Z" };
  const january = await fixture({ anchor, runs: [current] }).check();
  assert.equal(january.month, "2027-01");
  assert.equal(january.used, 1);
  assert.equal(january.resetsAt, "2027-02-01 00:00 Africa/Lagos");
});

test("checks stay anchored to the attempt even when other jobs start after it", async () => {
  const result = await fixture({ runs: [
    run(1),
    current,
    { ...current, id: 999 },
    { ...current, id: 1001 },
    run(2, { run_started_at: "2026-10-07T00:00:00Z" }),
  ] }).check();
  assert.equal(result.used, 3);
});

test("all history pages are read and repeated runs do not double-count", async () => {
  const oldRuns = Array.from({ length: 100 }, (_, i) => run(i + 1, { run_started_at: "2026-09-01T00:00:00Z" }));
  const history = fixture({ runs: [...oldRuns, current, run(101), run(101)] });
  const result = await history.check();
  assert.equal(result.used, 2);
  assert.ok(history.calls.includes("/workflows/7/runs?per_page=100&page=2"));
});

test("missing credentials, unreadable history, and malformed attempts fail closed", async () => {
  await assert.rejects(checkDesktopReleaseLimit({}), /requires GITHUB_REPOSITORY/);
  for (const failure of [{ httpError: 403 }, new Error("network unavailable"), { workflow_runs: null }]) {
    await assert.rejects(fixture({ overrides: { "/workflows/7/runs?per_page=100&page=1": failure } }).check());
  }
  for (const malformed of [run(1, { run_attempt: null }), run(1, { run_started_at: "invalid" }), run("invalid")]) {
    await assert.rejects(fixture({ runs: [malformed] }).check(), /invalid/);
  }
  await assert.rejects(fixture({ overrides: {
    "/runs/1000/attempts/1": { ...current, run_attempt: 2 },
  } }).check(), /different release attempt/);
});

import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const {
  DB_IDLE_TIMEOUT_MAX_MS, DB_IDLE_TIMEOUT_MIN_MS, DB_POOL_MAX_LIMIT, DEFAULT_DB_IDLE_TIMEOUT_MS, DEFAULT_DB_POOL_MAX,
  pool, resolveDbIdleTimeoutMs, resolveDbPoolMax,
} = await import("../db/client.js");

test("the API pool is larger than node-postgres' default of 10 unless DB_POOL_MAX says otherwise", async () => {
  const warnings: string[] = [];
  const resolve = (value: string) => resolveDbPoolMax(value, (line) => warnings.push(line));
  assert.ok(DEFAULT_DB_POOL_MAX > 10);
  assert.equal(resolve(""), DEFAULT_DB_POOL_MAX);
  assert.equal(resolve("40"), 40);
  assert.equal(resolve(" 7 "), 7);
  assert.equal(warnings.length, 0, "an unset or valid value warns nothing");

  for (const bad of ["0", "-3", "many", "20abc", "1e3", "2.5", "0x10"]) {
    assert.equal(resolve(bad), DEFAULT_DB_POOL_MAX, bad);
  }
  assert.equal(warnings.length, 7, "each bad value warns once");
  assert.equal(resolve("100000"), DB_POOL_MAX_LIMIT);
  assert.match(warnings.at(-1)!, /above/);

  assert.equal(pool.options.max, resolveDbPoolMax(process.env.DB_POOL_MAX, () => {}));
});

test("the API pool keeps idle connections for a minute unless DB_POOL_IDLE_TIMEOUT_MS says otherwise", () => {
  const warnings: string[] = [];
  const resolve = (value?: string) => resolveDbIdleTimeoutMs(value, (line) => warnings.push(line));
  assert.equal(DEFAULT_DB_IDLE_TIMEOUT_MS, 60_000);
  assert.equal(resolve(""), DEFAULT_DB_IDLE_TIMEOUT_MS);
  assert.equal(resolve(" 30000 "), 30_000);
  assert.equal(resolve(String(DB_IDLE_TIMEOUT_MIN_MS)), DB_IDLE_TIMEOUT_MIN_MS);
  assert.equal(resolve(String(DB_IDLE_TIMEOUT_MAX_MS)), DB_IDLE_TIMEOUT_MAX_MS);
  assert.equal(warnings.length, 0, "an unset or valid value warns nothing");

  for (const bad of ["0", "-5", "soon", "60s", "1e4", "2.5", "0x10"]) {
    assert.equal(resolve(bad), DEFAULT_DB_IDLE_TIMEOUT_MS, bad);
  }
  assert.equal(warnings.length, 7, "each bad value warns once");
  assert.equal(resolve("999"), DB_IDLE_TIMEOUT_MIN_MS);
  assert.match(warnings.at(-1)!, /below/);
  assert.equal(resolve("99999999"), DB_IDLE_TIMEOUT_MAX_MS);
  assert.match(warnings.at(-1)!, /above/);
});

test("the API pool sets the idle timeout and TCP keep-alive, and handles idle client errors", () => {
  assert.equal(pool.options.idleTimeoutMillis, resolveDbIdleTimeoutMs(process.env.DB_POOL_IDLE_TIMEOUT_MS, () => {}));
  assert.equal(pool.options.keepAlive, true);
  assert.equal(pool.options.keepAliveInitialDelayMillis, 10_000);
  assert.equal(pool.options.allowExitOnIdle, true, "a script that leaves the pool open must still exit at once");
  assert.ok(pool.listenerCount("error") > 0, "an unhandled pool error event would crash the process");
});

test.after(async () => { await pool.end(); });

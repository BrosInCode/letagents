import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { DB_POOL_MAX_LIMIT, DEFAULT_DB_POOL_MAX, pool, resolveDbPoolMax } = await import("../db/client.js");

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
  await pool.end();
});

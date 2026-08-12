import assert from "node:assert/strict";
import test from "node:test";

import {
  runBoundedProjectionBatch,
  runProjectionBatchWithRetry,
} from "../db/messages/projection-retry.js";

test("projection batch retry handles transient deadlock, serialization, and lock failures", async () => {
  const delays: number[] = [];
  const failures = ["55P03", "40P01"];
  let attempts = 0;
  const result = await runProjectionBatchWithRetry(
    async () => {
      const code = failures[attempts];
      attempts += 1;
      if (code) throw Object.assign(new Error(code), { code });
      return 7;
    },
    async (delayMs) => { delays.push(delayMs); },
    () => 0,
  );
  assert.equal(result, 7);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [25, 50]);

  let exhaustedAttempts = 0;
  await assert.rejects(
    runProjectionBatchWithRetry(async () => {
      exhaustedAttempts += 1;
      throw Object.assign(new Error("statement deadline"), { code: "57014" });
    }, async () => undefined, () => 0),
    /statement deadline/,
  );
  assert.equal(exhaustedAttempts, 3);

  let permanentAttempts = 0;
  await assert.rejects(
    runProjectionBatchWithRetry(async () => {
      permanentAttempts += 1;
      throw Object.assign(new Error("constraint"), { code: "23514" });
    }, async () => undefined),
    /constraint/,
  );
  assert.equal(permanentAttempts, 1);
});

test("projection batch transaction installs deadlines and releases on cancellation", async () => {
  const statements: string[] = [];
  let released = 0;
  const client = {
    async query(text: string) {
      statements.push(text);
      if (text.startsWith("SELECT reconcile")) {
        throw Object.assign(new Error("statement deadline"), { code: "57014" });
      }
      return { rows: [] };
    },
    release() { released += 1; },
  };
  await assert.rejects(
    runBoundedProjectionBatch({ connect: async () => client }, 500),
    /statement deadline/,
  );
  assert.deepEqual(statements, [
    "BEGIN",
    "SET LOCAL lock_timeout = '1s'",
    "SET LOCAL statement_timeout = '15s'",
    "SELECT reconcile_message_thread_projection($1)::int AS processed",
    "ROLLBACK",
  ]);
  assert.equal(released, 1);
});

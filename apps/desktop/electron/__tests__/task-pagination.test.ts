import assert from "node:assert/strict";
import test from "node:test";

import { drainPaginatedTaskPages } from "../main/rooms/snapshot/task-pagination.js";

type TestTask = { id: string; status: string };

function task(number: number, status = "proposed"): TestTask {
  return { id: `task_${number}`, status };
}

test("drainPaginatedTaskPages follows cursors past the first 200 tasks without duplicates", async () => {
  const tasks = Array.from({ length: 450 }, (_, index) =>
    task(index + 1, index === 324 ? "blocked" : "proposed"),
  );
  const cursors: Array<string | undefined> = [];

  const drained = await drainPaginatedTaskPages(async (after) => {
    cursors.push(after);
    const start = after ? Number(after.replace("task_", "")) : 0;
    const page = tasks.slice(start, start + 200);
    return {
      tasks: page,
      has_more: start + page.length < tasks.length,
    };
  });

  assert.deepEqual(cursors, [undefined, "task_200", "task_400"]);
  assert.equal(drained.length, 450);
  assert.equal(new Set(drained.map((item) => item.id)).size, 450);
  assert.equal(drained.find((item) => item.status === "blocked")?.id, "task_325");
});

test("drainPaginatedTaskPages stops cleanly at a terminal page", async () => {
  const tasks = Array.from({ length: 250 }, (_, index) => task(index + 1));
  let calls = 0;

  const drained = await drainPaginatedTaskPages(async (after) => {
    calls += 1;
    const start = after ? Number(after.replace("task_", "")) : 0;
    const page = tasks.slice(start, start + 200);
    return { tasks: page, has_more: start + page.length < tasks.length };
  });

  assert.equal(calls, 2);
  assert.equal(drained.length, 250);
});

test("drainPaginatedTaskPages stops when a page has no advancing cursor", async () => {
  let calls = 0;
  const drained = await drainPaginatedTaskPages<TestTask>(async () => {
    calls += 1;
    return { tasks: [], has_more: true };
  });

  assert.equal(calls, 1);
  assert.deepEqual(drained, []);
});

test("drainPaginatedTaskPages deduplicates and stops on a repeated cursor", async () => {
  let calls = 0;
  const drained = await drainPaginatedTaskPages(async () => {
    calls += 1;
    return { tasks: [task(1)], has_more: true };
  });

  assert.equal(calls, 2);
  assert.deepEqual(drained, [task(1)]);
});

test("drainPaginatedTaskPages preserves page request failures", async () => {
  const failure = new Error("tasks unavailable");

  await assert.rejects(
    () => drainPaginatedTaskPages<TestTask>(async () => {
      throw failure;
    }),
    failure,
  );
});

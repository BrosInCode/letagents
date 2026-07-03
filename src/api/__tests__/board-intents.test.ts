import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { hashBoardIntentPayload } = await import("../db/coordination/board-intents.js");

test("hashBoardIntentPayload is stable for object key order", () => {
  const first = hashBoardIntentPayload({
    task_id: "task_1",
    status: "assigned",
    assignee: "DawnWinter",
    metadata: {
      branch: "codex/board-manager-intents",
      checks: ["unit", "typecheck"],
    },
  } as never);
  const second = hashBoardIntentPayload({
    metadata: {
      checks: ["unit", "typecheck"],
      branch: "codex/board-manager-intents",
    },
    assignee: "DawnWinter",
    status: "assigned",
    task_id: "task_1",
  } as never);
  const arrayOrderChanged = hashBoardIntentPayload({
    task_id: "task_1",
    status: "assigned",
    assignee: "DawnWinter",
    metadata: {
      branch: "codex/board-manager-intents",
      checks: ["typecheck", "unit"],
    },
  } as never);

  assert.equal(first, second);
  assert.notEqual(first, arrayOrderChanged);
});

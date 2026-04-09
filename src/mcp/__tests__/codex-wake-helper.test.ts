import assert from "node:assert/strict";
import test from "node:test";

import { matchesWakeIntent } from "../codex-wake-helper.js";

test("matchesWakeIntent recognizes room rejoin requests", () => {
  assert.equal(matchesWakeIntent("join the room"), true);
  assert.equal(matchesWakeIntent("please rejoin"), true);
  assert.equal(matchesWakeIntent("wake up codex"), true);
});

test("matchesWakeIntent recognizes online-check wakeups", () => {
  assert.equal(matchesWakeIntent("are you guys online?"), true);
  assert.equal(matchesWakeIntent("come back"), true);
  assert.equal(matchesWakeIntent("back on room watch"), true);
});

test("matchesWakeIntent ignores regular work requests", () => {
  assert.equal(matchesWakeIntent("can you review PR #42"), false);
  assert.equal(matchesWakeIntent("implement task_27"), false);
  assert.equal(matchesWakeIntent(""), false);
});

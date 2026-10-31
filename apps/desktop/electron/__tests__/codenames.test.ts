import assert from "node:assert/strict";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({ prefix: "letagents-codenames-", paths: [] });

const { suggestLetAgentsCodename } = await import("../main/agents/codenames.js");

test("Codex codename suggestions avoid visible room names without provider numbering", () => {
  const visibleNames = ["MapleRidge", "CedarVista"];

  const suggested = suggestLetAgentsCodename(visibleNames, "stable-seed");

  assert.notEqual(suggested, "MapleRidge");
  assert.notEqual(suggested, "CedarVista");
  assert.doesNotMatch(suggested, /^Codex\s+\d+$/i);
  assert.doesNotMatch(suggested, /^Codex\b/i);
});

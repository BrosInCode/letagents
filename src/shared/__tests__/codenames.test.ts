import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_CODENAMES, AGENT_CODENAME_SPACE, codenameFromIndex } from "../codenames.js";

test("codenameFromIndex keeps the full two-part combination space for one-word codenames", () => {
  assert.equal(AGENT_CODENAME_SPACE, AGENT_CODENAMES.length * AGENT_CODENAMES.length);
});

test("codenameFromIndex returns fused one-word names for new codenames", () => {
  const codename = codenameFromIndex(0);

  assert.equal(codename.name, "amberamber");
  assert.equal(codename.display_name, "AmberAmber");
  assert.equal(codename.name.includes("-"), false);
  assert.equal(codename.display_name.includes(" "), false);
});

test("codenameFromIndex keeps distinct indices distinct", () => {
  assert.notDeepEqual(codenameFromIndex(0), codenameFromIndex(1));
  assert.notDeepEqual(codenameFromIndex(AGENT_CODENAMES.length), codenameFromIndex(1));
});

test("every runtime derives the same name from the same seed", async () => {
  const { pickLocalCodename } = await import("../codenames.js");
  const shared = await import("../../../shared/agent-codenames.mjs");
  assert.equal(shared.AGENT_CODENAME_SPACE, AGENT_CODENAME_SPACE);
  for (const seed of ["owner/agent", "worker_0123", "supervised_e730326a", "owner/agent:3"]) {
    assert.equal(
      shared.agentCodenameAt(shared.agentCodenameSeedIndex(seed)),
      pickLocalCodename(seed).display_name,
    );
  }
  // The pool order is identity-bearing for legacy MCP agents.
  assert.deepEqual(
    [AGENT_CODENAMES[0], AGENT_CODENAMES[50], AGENT_CODENAMES[AGENT_CODENAMES.length - 1]],
    ["amber", "mesa", "wren"],
  );
});

test("a suggested name avoids every spelling of a held name", async () => {
  const { agentDisplayNameKey, suggestFreeAgentCodename } = await import("../../../shared/agent-codenames.mjs");
  const first = suggestFreeAgentCodename([], "seed-a")!;
  const second = suggestFreeAgentCodename([first.toLowerCase()], "seed-a")!;
  assert.match(first, /^[A-Za-z]+$/);
  assert.notEqual(agentDisplayNameKey(second), agentDisplayNameKey(first));
  assert.equal(suggestFreeAgentCodename([], "seed-a"), first, "the same seed is offered the same name");
});

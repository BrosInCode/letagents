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

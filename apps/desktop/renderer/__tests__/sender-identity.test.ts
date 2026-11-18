import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSenderIdentity, resolveOwnerAttribution } from "../src/components/desktop/content/desktop-chat-message/identity";

test("the desktop reads senders with the shared parser and hides the generic Agent label", () => {
  assert.deepEqual(parseSenderIdentity({ sender: "RiverFox | Ada's agent | Codex" }), { displayName: "RiverFox", ownerAttribution: "Ada's agent", ideLabel: "Codex" });
  assert.equal(parseSenderIdentity({ sender: "MossFinch | Ada's agent | Agent" }).ideLabel, null);
  assert.equal(parseSenderIdentity({ sender: "" }).displayName, "Unknown");
  assert.equal(parseSenderIdentity({ sender: "codex-7 (Ada's agent)" }).ownerAttribution, "Ada's agent");
  assert.equal(resolveOwnerAttribution({ ownerLabel: "James" }), "James' agent");
  assert.equal(resolveOwnerAttribution({ actorLabel: "RiverFox | Ada's agent | Codex" }), "Ada's agent");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRentalSafePermissionProfile,
  isRentalSafePermissionProfile,
  listRentalSafePermissionProfiles,
} from "../main/agents/rental-permission-profiles.js";

test("only a verified workspace-rooted provider profile is rental-admissible", () => {
  assert.deepEqual(
    listRentalSafePermissionProfiles("cursor").map((profile) => profile.id),
    ["sandboxed_write"],
  );
  assert.deepEqual(listRentalSafePermissionProfiles("codex"), []);
  assert.deepEqual(listRentalSafePermissionProfiles("claude-code"), []);
  assert.deepEqual(listRentalSafePermissionProfiles("open-model"), []);
  assert.equal(isRentalSafePermissionProfile("cursor", "sandboxed_write"), true);
  assert.equal(isRentalSafePermissionProfile("cursor", "full_access"), false);
  assert.throws(
    () => assertRentalSafePermissionProfile("codex", "full_access"),
    /verified workspace-rooted rental profile/,
  );
});

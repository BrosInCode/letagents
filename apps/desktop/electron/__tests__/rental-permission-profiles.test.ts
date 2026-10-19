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
  // Codex is admitted only Read-only, where a guest launch switches off every local tool (codex-guest-lock).
  assert.deepEqual(listRentalSafePermissionProfiles("codex").map((profile) => profile.id), ["read_only"]);
  // Claude is admitted only Read-only, where a guest launch carries no built-in tools (provider-spawn-configuration).
  assert.deepEqual(listRentalSafePermissionProfiles("claude-code").map((profile) => profile.id), ["read_only"]);
  assert.equal(isRentalSafePermissionProfile("claude-code", "full_access"), false);
  assert.deepEqual(listRentalSafePermissionProfiles("open-model"), []);
  assert.equal(isRentalSafePermissionProfile("cursor", "sandboxed_write"), true);
  assert.equal(isRentalSafePermissionProfile("cursor", "full_access"), false);
  assert.equal(isRentalSafePermissionProfile("codex", "read_only"), true);
  assert.throws(
    () => assertRentalSafePermissionProfile("codex", "full_access"),
    /rental-safe permission profile for codex/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({ prefix: "letagents-managed-agent-permission-profiles-", paths: [] });

const {
  assertManagedAgentPermissionProfileAvailable,
  listManagedAgentPermissionProfiles,
  managedAgentPermissionProfileForProvider,
} = await import("../main/agents/managed-agent-permission-profiles.js");

test("managed agent permission profiles map provider-specific available and gated modes", () => {
  const claudeProfiles = listManagedAgentPermissionProfiles("claude-code");
  assert.equal(claudeProfiles.find((profile) => profile.id === "ask_before_write")?.status, "gated");
  assert.equal(claudeProfiles.find((profile) => profile.id === "read_only")?.status, "available");
  assert.match(claudeProfiles.find((profile) => profile.id === "read_only")?.detail ?? "", /Cannot change files or run commands/);
  assert.equal(claudeProfiles.find((profile) => profile.id === "full_access")?.status, "available");
  assert.match(claudeProfiles.find((profile) => profile.id === "full_access")?.description ?? "", /on this computer/);
  assert.doesNotMatch(claudeProfiles.find((profile) => profile.id === "full_access")?.description ?? "", /repo|workspace/i);

  const cursorProfiles = listManagedAgentPermissionProfiles("cursor");
  assert.equal(cursorProfiles.find((profile) => profile.id === "read_only")?.status, "available");
  assert.equal(cursorProfiles.find((profile) => profile.id === "sandboxed_write")?.status, "available");
  assert.equal(cursorProfiles.find((profile) => profile.id === "full_access")?.status, "available");
  assert.equal(cursorProfiles.find((profile) => profile.id === "ask_before_write")?.status, "gated");
  assert.equal(cursorProfiles.find((profile) => profile.id === "read_only")?.isDefault, true);

  const codexProfiles = listManagedAgentPermissionProfiles("codex");
  assert.equal(codexProfiles.find((profile) => profile.id === "full_access")?.status, "available");
  assert.equal(codexProfiles.find((profile) => profile.id === "ask_before_write")?.status, "gated");
  assert.equal(
    assertManagedAgentPermissionProfileAvailable("codex", "ask_before_write").status,
    "available",
  );
  assert.equal(
    assertManagedAgentPermissionProfileAvailable("open-model", "ask_before_write").status,
    "available",
  );
  // The catalog lists Codex Read-only as gated; the start check makes it available.
  assert.equal(codexProfiles.find((profile) => profile.id === "read_only")?.status, "gated");
  const supervisedCodexReadOnly = assertManagedAgentPermissionProfileAvailable("codex", "read_only");
  assert.equal(supervisedCodexReadOnly.status, "available");
  assert.equal(supervisedCodexReadOnly.risk, "medium");
  assert.equal(supervisedCodexReadOnly.description, "Can read files on this computer, also outside your project, and read and post in the room.");
  assert.equal(supervisedCodexReadOnly.detail, "Cannot change files. Its commands cannot use the network, and web search is off. Its commands cannot read your Codex sign-in file. It asks for no approval: a command that needs more is refused. Your saved Codex command rules do not apply to it. It cannot change the task board, join rooms or submit reviews.");
  assert.equal(codexProfiles.find((profile) => profile.isDefault)?.id, "full_access");
  assert.throws(
    () => assertManagedAgentPermissionProfileAvailable("codex", "sandboxed_write"),
    /Sandboxed writes is not available for codex/,
  );
  assert.throws(
    () => assertManagedAgentPermissionProfileAvailable("open-model", "read_only"),
    /Read-only is not available for open-model/,
  );

  for (const provider of ["claude-code", "codex", "open-model"] as const) {
    assert.equal(listManagedAgentPermissionProfiles(provider).find((profile) => profile.id === "auto_review")?.status, "gated");
    const supervised = assertManagedAgentPermissionProfileAvailable(provider, "auto_review");
    assert.equal(supervised.status, "available");
    assert.equal(supervised.risk, "high");
    assert.match(supervised.detail ?? "", provider === "open-model"
      ? /Reading and checking commands are sent to LetAgents and to Jev/
      : /Anything a room message asks for counts as approved/);
  }
  assert.throws(() => assertManagedAgentPermissionProfileAvailable("cursor", "auto_review"), /Unknown permission profile 'auto_review'/);

  assert.equal(managedAgentPermissionProfileForProvider("claude-code", null).id, "read_only");
  assert.equal(managedAgentPermissionProfileForProvider("cursor", null).id, "read_only");
  assert.equal(assertManagedAgentPermissionProfileAvailable("cursor", "full_access").id, "full_access");
  assert.throws(
    () => assertManagedAgentPermissionProfileAvailable("cursor", "unknown_profile"),
    /Unknown permission profile 'unknown_profile' for cursor/,
  );
});

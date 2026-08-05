import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveProviderConfigurationSnapshot,
  providerSupportsConcurrentSupervisedAgents,
  resolveProviderConfigurationSnapshot,
} from "../provider-configuration.js";
import { supervisedPermissionProfilesForProvider } from "../supervised-permission-profiles.js";

test("provider configuration maps permission profiles to native launch authority", () => {
  assert.deepEqual(resolveProviderConfigurationSnapshot({
    provider: "codex",
    model: "gpt-next",
    reasoningEffort: "high",
    permissionProfileId: "full_access",
    launchPolicy: { experimental: true },
    configurationRevision: 7,
  }), {
    provider: "codex",
    model: "gpt-next",
    reasoningEffort: "high",
    permissionProfileId: "full_access",
    launchPolicy: {
      experimental: true,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    },
    configurationRevision: 7,
  });

  assert.deepEqual(resolveProviderConfigurationSnapshot({
    provider: "claude-code",
    model: "claude-next",
    reasoningEffort: null,
    permissionProfileId: "read_only",
    launchPolicy: { allowedTools: ["Read", "Glob"] },
    configurationRevision: 3,
  }).launchPolicy, {
    allowedTools: ["Read", "Glob"],
    permissionMode: "plan",
    dangerouslySkipPermissions: false,
  });

  assert.equal(resolveProviderConfigurationSnapshot({
    provider: "claude-code",
    model: null,
    reasoningEffort: null,
    permissionProfileId: null,
    launchPolicy: {},
    configurationRevision: 1,
  }).permissionProfileId, "read_only");

  assert.deepEqual(resolveProviderConfigurationSnapshot({
    provider: "cursor",
    model: null,
    reasoningEffort: null,
    permissionProfileId: "sandboxed_write",
    launchPolicy: {},
    configurationRevision: 5,
  }).launchPolicy, {
    force: true,
    sandbox: "enabled",
  });

  assert.deepEqual(resolveProviderConfigurationSnapshot({
    provider: "cursor",
    model: null,
    reasoningEffort: null,
    permissionProfileId: "read_only",
    launchPolicy: {},
    configurationRevision: 6,
  }).launchPolicy, {
    mode: "ask",
    force: false,
  });

  assert.deepEqual(resolveProviderConfigurationSnapshot({
    provider: "cursor",
    model: null,
    reasoningEffort: null,
    permissionProfileId: null,
    launchPolicy: {},
    configurationRevision: 7,
  }), {
    provider: "cursor",
    model: null,
    reasoningEffort: null,
    permissionProfileId: "sandboxed_write",
    launchPolicy: { force: true, sandbox: "enabled" },
    configurationRevision: 7,
  });
});

test("trusted profile selection replaces only native authority and preserves provider options", () => {
  assert.deepEqual(deriveProviderConfigurationSnapshot({
    provider: "codex", model: "gpt-next", reasoningEffort: "high", permissionProfileId: "full_access", configurationRevision: 8,
  }, {
    approvalPolicy: "ask", sandboxPolicy: { type: "workspaceWrite" }, experimental: true,
  }).launchPolicy, {
    experimental: true, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" },
  });

  assert.deepEqual(deriveProviderConfigurationSnapshot({
    provider: "claude-code", model: "claude-next", reasoningEffort: null, permissionProfileId: "full_access", configurationRevision: 4,
  }, {
    permissionMode: "plan", dangerouslySkipPermissions: false, allowedTools: ["Read", "Glob"], maxTurns: 6,
  }).launchPolicy, {
    allowedTools: ["Read", "Glob"], maxTurns: 6, permissionMode: "bypassPermissions", dangerouslySkipPermissions: true,
  });

  assert.deepEqual(deriveProviderConfigurationSnapshot({
    provider: "cursor", model: null, reasoningEffort: null, permissionProfileId: null, configurationRevision: 5,
  }, {
    force: true, sandbox: "disabled",
  }), {
    provider: "cursor",
    model: null,
    reasoningEffort: null,
    permissionProfileId: "sandboxed_write",
    launchPolicy: { force: true, sandbox: "enabled" },
    configurationRevision: 5,
  });

  assert.deepEqual(deriveProviderConfigurationSnapshot({
    provider: "claude-code", model: "claude-next", reasoningEffort: null, permissionProfileId: "read_only", configurationRevision: 4,
  }, {
    permissionMode: "bypassPermissions", dangerouslySkipPermissions: true, allowedTools: ["Read", "Glob"], maxTurns: 6,
  }).launchPolicy, {
    allowedTools: ["Read", "Glob"], maxTurns: 6, permissionMode: "plan", dangerouslySkipPermissions: false,
  });

  assert.deepEqual(deriveProviderConfigurationSnapshot({
    provider: "open-model", model: "qwen-next", reasoningEffort: null, permissionProfileId: "full_access", configurationRevision: 8,
  }, {
    permission: { "*": "ask" }, experimental: true,
  }).launchPolicy, {
    experimental: true, permission: { "*": "allow" },
  });

  assert.deepEqual(deriveProviderConfigurationSnapshot({
    provider: "cursor", model: null, reasoningEffort: null, permissionProfileId: "read_only", configurationRevision: 6,
  }, { mode: "ask", force: false, sandbox: null }).launchPolicy, {
    mode: "ask", force: false,
  });
  assert.throws(() => deriveProviderConfigurationSnapshot({
    provider: "cursor", model: null, reasoningEffort: null, permissionProfileId: "read_only", configurationRevision: 6,
  }, { mode: "ask", force: false, workspace: "elsewhere" }), /unsupported native option 'workspace'/);
});

test("provider configuration rejects unsupported and conflicting native settings", () => {
  assert.throws(() => resolveProviderConfigurationSnapshot({
    provider: "claude-code",
    model: null,
    reasoningEffort: "high",
    permissionProfileId: "ask_before_write",
    launchPolicy: {},
    configurationRevision: 1,
  }), /does not support reasoning effort/);

  assert.throws(() => resolveProviderConfigurationSnapshot({
    provider: "cursor",
    model: null,
    reasoningEffort: null,
    permissionProfileId: "full_access",
    launchPolicy: { sandbox: "enabled" },
    configurationRevision: 1,
  }), /conflicts with permission-profile authority/);

  assert.throws(() => resolveProviderConfigurationSnapshot({
    provider: "codex",
    model: null,
    reasoningEffort: null,
    permissionProfileId: "read_only",
    launchPolicy: {},
    configurationRevision: 1,
  }), /unavailable for provider/);

  assert.throws(() => deriveProviderConfigurationSnapshot({
    provider: "claude-code", model: null, reasoningEffort: null, permissionProfileId: "ask_before_write", configurationRevision: 1,
  }, {}), /Claude supervised prompt bridging is not available/);
});

test("supervised profile contract gates Claude prompt approval without changing generic provider policy", () => {
  const claude = supervisedPermissionProfilesForProvider("claude-code");
  assert.equal(claude.find((profile) => profile.id === "ask_before_write")?.status, "gated");
  assert.equal(claude.find((profile) => profile.id === "read_only")?.status, "available");
  assert.equal(claude.find((profile) => profile.id === "full_access")?.status, "available");
  assert.equal(supervisedPermissionProfilesForProvider("codex").find((profile) => profile.id === "full_access")?.status, "available");
  assert.equal(supervisedPermissionProfilesForProvider("open-model").find((profile) => profile.id === "full_access")?.status, "available");
  const cursor = supervisedPermissionProfilesForProvider("cursor");
  assert.equal(cursor.find((profile) => profile.id === "read_only")?.status, "available");
  assert.equal(cursor.find((profile) => profile.id === "ask_before_write")?.status, "gated");
  assert.equal(cursor.find((profile) => profile.id === "sandboxed_write")?.status, "available");
  assert.equal(cursor.find((profile) => profile.id === "read_only")?.isDefault, false);
  assert.equal(cursor.find((profile) => profile.id === "sandboxed_write")?.isDefault, true);
  assert.equal(cursor.find((profile) => profile.id === "full_access")?.status, "available");
});

test("isolated supervised provider runtimes admit multiple agents in one room", () => {
  assert.equal(providerSupportsConcurrentSupervisedAgents("codex"), true);
  assert.equal(providerSupportsConcurrentSupervisedAgents("claude-code"), true);
  assert.equal(providerSupportsConcurrentSupervisedAgents("claude"), true);
  assert.equal(providerSupportsConcurrentSupervisedAgents("open-model"), true);
  assert.equal(providerSupportsConcurrentSupervisedAgents("cursor"), true);
});

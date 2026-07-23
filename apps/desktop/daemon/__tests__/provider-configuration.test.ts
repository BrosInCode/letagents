import assert from "node:assert/strict";
import test from "node:test";

import { resolveProviderConfigurationSnapshot } from "../provider-configuration.js";

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
});

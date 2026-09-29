import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveProviderConfigurationSnapshot,
  providerSupportsConcurrentSupervisedAgents,
  resolveProviderConfigurationSnapshot,
} from "../provider-configuration.js";
import {
  assertSupervisedRentalPermissionProfileAvailable,
  supervisedPermissionProfilesForProvider,
} from "../supervised-permission-profiles.js";

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
    provider: "codex",
    model: null,
    reasoningEffort: null,
    permissionProfileId: "ask_before_write",
    launchPolicy: {},
    configurationRevision: 8,
  }).launchPolicy, {
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  });

  assert.deepEqual(resolveProviderConfigurationSnapshot({
    provider: "claude-code",
    model: "claude-next",
    reasoningEffort: null,
    permissionProfileId: "read_only",
    launchPolicy: {},
    configurationRevision: 3,
  }).launchPolicy, {
    permissionMode: "dontAsk",
    dangerouslySkipPermissions: false,
    tools: ["Read", "Glob", "Grep"],
    allowedTools: ["mcp__letagents__*"],
    settingSources: "",
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
    provider: "open-model",
    model: "qwen-next",
    reasoningEffort: null,
    permissionProfileId: "ask_before_write",
    launchPolicy: {},
    configurationRevision: 4,
  }).launchPolicy, {
    permission: { "*": "allow", edit: "ask", bash: "ask" },
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
    provider: "codex", model: "gpt-next", reasoningEffort: "high", permissionProfileId: "ask_before_write", configurationRevision: 9,
  }, {
    approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, experimental: true,
  }).launchPolicy, {
    experimental: true,
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  });

  assert.deepEqual(deriveProviderConfigurationSnapshot({
    provider: "claude-code", model: "claude-next", reasoningEffort: null, permissionProfileId: "full_access", configurationRevision: 4,
  }, {
    permissionMode: "plan", dangerouslySkipPermissions: false, allowedTools: ["Read", "Glob"], tools: ["Read"], settingSources: "user", maxTurns: 6,
  }).launchPolicy, {
    maxTurns: 6, permissionMode: "bypassPermissions", dangerouslySkipPermissions: true,
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
    maxTurns: 6, permissionMode: "dontAsk", dangerouslySkipPermissions: false,
    allowedTools: ["mcp__letagents__*"],
    tools: ["Read", "Glob", "Grep"], settingSources: "",
  });

  assert.deepEqual(deriveProviderConfigurationSnapshot({
    provider: "claude-code", model: "claude-next", reasoningEffort: null, permissionProfileId: "full_access", configurationRevision: 5,
  }, {
    permissionMode: "bypassPermissions", dangerouslySkipPermissions: true,
    allowedTools: ["Read"], tools: ["Read"], settingSources: "user", maxTurns: 6,
  }).launchPolicy, {
    allowedTools: ["Read"], tools: ["Read"], settingSources: "user", maxTurns: 6,
    permissionMode: "bypassPermissions", dangerouslySkipPermissions: true,
  });

  assert.deepEqual(deriveProviderConfigurationSnapshot({
    provider: "open-model", model: "qwen-next", reasoningEffort: null, permissionProfileId: "full_access", configurationRevision: 8,
  }, {
    permission: { "*": "ask" }, experimental: true,
  }).launchPolicy, {
    experimental: true, permission: { "*": "allow" },
  });

  assert.deepEqual(deriveProviderConfigurationSnapshot({
    provider: "open-model", model: "qwen-next", reasoningEffort: null, permissionProfileId: "ask_before_write", configurationRevision: 9,
  }, {
    permission: { "*": "allow" }, experimental: true,
  }).launchPolicy, {
    experimental: true, permission: { "*": "allow", edit: "ask", bash: "ask" },
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
    reasoningEffort: null,
    permissionProfileId: "read_only",
    launchPolicy: { tools: ["Bash"] },
    configurationRevision: 1,
  }), /conflicts with permission-profile authority at 'tools'/);

  assert.throws(() => resolveProviderConfigurationSnapshot({
    provider: "claude-code",
    model: null,
    reasoningEffort: null,
    permissionProfileId: "read_only",
    launchPolicy: {
      tools: ["Read", "Glob", "Grep"],
      allowedTools: [],
    },
    configurationRevision: 1,
  }), /conflicts with permission-profile authority at 'allowedTools'/);

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

  assert.throws(() => resolveProviderConfigurationSnapshot({
    provider: "codex",
    model: null,
    reasoningEffort: null,
    permissionProfileId: "ask_before_write",
    launchPolicy: { sandboxPolicy: { type: "dangerFullAccess" } },
    configurationRevision: 1,
  }), /conflicts with permission-profile authority/);

  assert.throws(() => resolveProviderConfigurationSnapshot({
    provider: "codex",
    model: null,
    reasoningEffort: null,
    permissionProfileId: "ask_before_write",
    launchPolicy: { sandbox: "danger-full-access" },
    configurationRevision: 1,
  }), /cannot override 'sandbox'/);

  assert.equal(deriveProviderConfigurationSnapshot({
    provider: "claude-code", model: null, reasoningEffort: null, permissionProfileId: "ask_before_write", configurationRevision: 1,
  }, {}).launchPolicy.permissionMode, "default");
});

test("supervised profile contract exposes Claude prompt approval while retaining existing provider profiles", () => {
  const claude = supervisedPermissionProfilesForProvider("claude-code");
  assert.equal(claude.find((profile) => profile.id === "ask_before_write")?.status, "available");
  assert.equal(claude.find((profile) => profile.id === "read_only")?.status, "available");
  assert.match(claude.find((profile) => profile.id === "read_only")?.detail ?? "", /Cannot change files or run commands/);
  assert.equal(claude.find((profile) => profile.id === "full_access")?.status, "available");
  assert.match(claude.find((profile) => profile.id === "full_access")?.description ?? "", /on this Mac/);
  assert.doesNotMatch(claude.find((profile) => profile.id === "full_access")?.description ?? "", /repo|workspace/i);
  const codex = supervisedPermissionProfilesForProvider("codex");
  assert.equal(codex.find((profile) => profile.id === "full_access")?.status, "available");
  assert.equal(codex.find((profile) => profile.id === "ask_before_write")?.status, "available");
  assert.match(codex.find((profile) => profile.id === "ask_before_write")?.detail ?? "", /read-only file access and no network access/);
  assert.equal(supervisedPermissionProfilesForProvider("open-model").find((profile) => profile.id === "full_access")?.status, "available");
  assert.equal(supervisedPermissionProfilesForProvider("open-model").find((profile) => profile.id === "ask_before_write")?.status, "available");
  const cursor = supervisedPermissionProfilesForProvider("cursor");
  assert.equal(cursor.find((profile) => profile.id === "read_only")?.status, "available");
  assert.equal(cursor.find((profile) => profile.id === "ask_before_write")?.status, "gated");
  assert.match(cursor.find((profile) => profile.id === "ask_before_write")?.detail ?? "", /does not request approval for every workspace edit/);
  assert.throws(() => deriveProviderConfigurationSnapshot({
    provider: "cursor", model: null, reasoningEffort: null, permissionProfileId: "ask_before_write", configurationRevision: 1,
    launchPolicy: { force: false, sandbox: "enabled" },
  }, {}), /does not request approval for every workspace edit/);
  assert.equal(cursor.find((profile) => profile.id === "sandboxed_write")?.status, "available");
  assert.equal(cursor.find((profile) => profile.id === "read_only")?.isDefault, false);
  assert.equal(cursor.find((profile) => profile.id === "sandboxed_write")?.isDefault, true);
  assert.equal(cursor.find((profile) => profile.id === "full_access")?.status, "available");
});

test("rental admission rejects trusted-local profiles at the daemon launch boundary", () => {
  assert.equal(
    assertSupervisedRentalPermissionProfileAvailable("cursor", "sandboxed_write"),
    "sandboxed_write",
  );
  assert.throws(
    () => assertSupervisedRentalPermissionProfileAvailable("cursor", "full_access"),
    /verified workspace-rooted permission profile/,
  );
  assert.throws(
    () => assertSupervisedRentalPermissionProfileAvailable("codex", "full_access"),
    /verified workspace-rooted permission profile/,
  );
});

test("isolated supervised provider runtimes admit multiple agents in one room", () => {
  assert.equal(providerSupportsConcurrentSupervisedAgents("codex"), true);
  assert.equal(providerSupportsConcurrentSupervisedAgents("claude-code"), true);
  assert.equal(providerSupportsConcurrentSupervisedAgents("claude"), true);
  assert.equal(providerSupportsConcurrentSupervisedAgents("open-model"), true);
  assert.equal(providerSupportsConcurrentSupervisedAgents("cursor"), true);
});

test("Auto hands approval review to the provider and leaves no trace when switched away", () => {
  const codex = { provider: "codex", model: null, reasoningEffort: null, configurationRevision: 3 } as const;
  const codexAuto = deriveProviderConfigurationSnapshot({ ...codex, permissionProfileId: "auto_review" }, {
    approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, experimental: true,
  });
  assert.deepEqual(codexAuto.launchPolicy, {
    experimental: true,
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
    approvalsReviewer: "auto_review",
  });
  // Leaving Auto must return approvals to the host, not keep the reviewer.
  assert.deepEqual(deriveProviderConfigurationSnapshot({ ...codex, permissionProfileId: "ask_before_write" }, codexAuto.launchPolicy).launchPolicy, {
    experimental: true,
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  });
  assert.deepEqual(deriveProviderConfigurationSnapshot({ ...codex, permissionProfileId: "full_access" }, codexAuto.launchPolicy).launchPolicy, {
    experimental: true,
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  });
  for (const permissionProfileId of ["ask_before_write", "full_access"]) {
    assert.throws(() => resolveProviderConfigurationSnapshot({
      ...codex, permissionProfileId, launchPolicy: { approvalsReviewer: "auto_review" },
    }), /conflicts with permission-profile authority at 'approvalsReviewer'/);
  }
  assert.throws(() => resolveProviderConfigurationSnapshot({
    ...codex, permissionProfileId: "auto_review", launchPolicy: { approvalsReviewer: "user" },
  }), /conflicts with permission-profile authority at 'approvalsReviewer'/);
  assert.throws(() => resolveProviderConfigurationSnapshot({
    ...codex, permissionProfileId: "auto_review", launchPolicy: { sandboxPolicy: { type: "dangerFullAccess" } },
  }), /conflicts with permission-profile authority at 'sandboxPolicy'/);

  const claude = { provider: "claude-code", model: null, reasoningEffort: null, configurationRevision: 4 } as const;
  const claudeAuto = deriveProviderConfigurationSnapshot({ ...claude, permissionProfileId: "auto_review" }, {
    permissionMode: "bypassPermissions", dangerouslySkipPermissions: true, allowedTools: ["*"],
    settings: '{"permissions":{"allow":["Bash"]}}', settingSources: "user,project", maxTurns: 9,
  });
  assert.deepEqual(claudeAuto.launchPolicy, {
    maxTurns: 9,
    permissionMode: "auto", dangerouslySkipPermissions: false, allowDangerouslySkipPermissions: false,
    tools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"],
    allowedTools: ["mcp__letagents__*"], settingSources: "", settings: "{}",
  });
  assert.throws(() => resolveProviderConfigurationSnapshot({
    ...claude, permissionProfileId: "auto_review", launchPolicy: { "permission-mode": "bypassPermissions" },
  }), /Claude approval profile cannot override 'permission-mode'/);
  assert.deepEqual(deriveProviderConfigurationSnapshot({ ...claude, permissionProfileId: "full_access" }, claudeAuto.launchPolicy).launchPolicy,
    { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true, maxTurns: 9 });
  assert.equal(deriveProviderConfigurationSnapshot({ ...claude, permissionProfileId: "ask_before_write" }, claudeAuto.launchPolicy).launchPolicy.permissionMode, "default");
  assert.deepEqual(deriveProviderConfigurationSnapshot({ ...claude, permissionProfileId: "read_only" }, claudeAuto.launchPolicy).launchPolicy, {
    maxTurns: 9, permissionMode: "dontAsk", dangerouslySkipPermissions: false,
    tools: ["Read", "Glob", "Grep"], allowedTools: ["mcp__letagents__*"], settingSources: "",
  });

  assert.equal(supervisedPermissionProfilesForProvider("claude-code").find((profile) => profile.id === "auto_review")?.status, "available");
  assert.equal(supervisedPermissionProfilesForProvider("claude-code").find((profile) => profile.id === "auto_review")?.risk, "high");
  assert.equal(supervisedPermissionProfilesForProvider("codex").find((profile) => profile.id === "auto_review")?.status, "available");
  assert.equal(supervisedPermissionProfilesForProvider("codex").find((profile) => profile.id === "auto_review")?.risk, "high");
  for (const provider of ["open-model", "cursor"]) {
    assert.equal(supervisedPermissionProfilesForProvider(provider).some((profile) => profile.id === "auto_review"), false);
    assert.throws(() => deriveProviderConfigurationSnapshot({
      provider, model: null, reasoningEffort: null, permissionProfileId: "auto_review", configurationRevision: 1,
    }, {}), /unavailable/);
  }
  assert.throws(() => assertSupervisedRentalPermissionProfileAvailable("codex", "auto_review"), /verified workspace-rooted/);
});

test("Claude approval profile strips previous broad authority and can return to existing profiles", () => {
  const selection = { provider: "claude-code", model: null, reasoningEffort: null, configurationRevision: 2 } as const;
  const ask = deriveProviderConfigurationSnapshot({ ...selection, permissionProfileId: "ask_before_write" }, {
    permissionMode: "bypassPermissions", dangerouslySkipPermissions: true, allowedTools: ["*"],
    settings: '{"permissions":{"allow":["Bash"]}}', settingSources: "user,project", maxTurns: 9,
  });
  assert.equal(ask.launchPolicy.permissionMode, "default");
  assert.deepEqual(ask.launchPolicy.allowedTools, ["mcp__letagents__*"]);
  assert.equal(ask.launchPolicy.settings, "{}");
  assert.equal(ask.launchPolicy.settingSources, "");
  assert.equal(ask.launchPolicy.maxTurns, 9);
  const full = deriveProviderConfigurationSnapshot({ ...selection, permissionProfileId: "full_access" }, ask.launchPolicy);
  assert.deepEqual(full.launchPolicy, { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true, maxTurns: 9 });
  const read = deriveProviderConfigurationSnapshot({ ...selection, permissionProfileId: "read_only" }, ask.launchPolicy);
  assert.equal(read.launchPolicy.permissionMode, "dontAsk");
  assert.deepEqual(read.launchPolicy.tools, ["Read", "Glob", "Grep"]);
});

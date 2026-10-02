import assert from "node:assert/strict";
import test from "node:test";

import {
  HOME_HARNESS_ON,
  HOME_HARNESS_POLICY_KEY,
  agentUsesHomeHarness,
  deriveProviderConfigurationSnapshot,
  entryLaunchPolicy,
  homeHarnessAvailability,
  homeHarnessChangeKey,
  homeHarnessDiffersFromSaved,
  homeHarnessRosterState,
  homeHarnessState,
  namesHomeHarness,
  ownerSetupRef,
  startedWithHomeHarness,
  providerSupportsConcurrentSupervisedAgents,
  resolveProviderConfigurationSnapshot,
  storedHomeHarness,
  storedLaunchPolicy,
  withoutHomeHarness,
} from "../provider-configuration.js";
import { attestProviderSpawnPolicy } from "../../electron/main/agents/provider-spawn-configuration.js";
import {
  assertSupervisedRentalPermissionProfileAvailable,
  describeProfilesWithOwnerSetup,
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
  assert.equal(supervisedPermissionProfilesForProvider("cursor").some((profile) => profile.id === "auto_review"), false);
  assert.throws(() => deriveProviderConfigurationSnapshot({
    provider: "cursor", model: null, reasoningEffort: null, permissionProfileId: "auto_review", configurationRevision: 1,
  }, {}), /unavailable/);

  const openModel = { provider: "open-model", model: "qwen-next", reasoningEffort: null, configurationRevision: 5 } as const;
  const openModelAuto = deriveProviderConfigurationSnapshot({ ...openModel, permissionProfileId: "auto_review" }, { permission: { "*": "allow" }, share: "disabled" });
  // Nothing outside the project is opened: no review could see what a command does there.
  assert.deepEqual(openModelAuto.launchPolicy, {
    share: "disabled", permission: { "*": "allow", edit: "ask", bash: "ask", external_directory: "deny" },
  });
  assert.deepEqual(deriveProviderConfigurationSnapshot({ ...openModel, permissionProfileId: "ask_before_write" }, openModelAuto.launchPolicy).launchPolicy,
    { share: "disabled", permission: { "*": "allow", edit: "ask", bash: "ask" } });
  assert.deepEqual(deriveProviderConfigurationSnapshot({ ...openModel, permissionProfileId: "full_access" }, openModelAuto.launchPolicy).launchPolicy,
    { share: "disabled", permission: { "*": "allow" } });
  for (const permission of [{ "*": "allow" }, { "*": "allow", edit: "ask", bash: "ask" }, { "*": "allow", edit: "ask", bash: "ask", external_directory: "ask" }]) {
    assert.throws(() => resolveProviderConfigurationSnapshot({ ...openModel, permissionProfileId: "auto_review", launchPolicy: { permission } }),
      /conflicts with permission-profile authority at 'permission'/);
  }
  assert.equal(supervisedPermissionProfilesForProvider("open-model").find((profile) => profile.id === "auto_review")?.status, "available");
  assert.equal(supervisedPermissionProfilesForProvider("open-model").find((profile) => profile.id === "auto_review")?.risk, "high");
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

/** An agent the daemon delivers room messages to, which is the only kind that may have the owner's setup. */
const agentOn = (id: string, provider: string, deliveryMode: string | null | undefined = "daemon_inbox") => ({ id, provider, deliveryMode });
/** The stored form of "on": isolation from the owner's setup, exactly `false`. */
const OWN_SETUP = HOME_HARNESS_ON;
/** The stored form of the revisions at which the choice changed. */
const changedAt = (...revisions: number[]) => Object.fromEntries(revisions.map((revision) => [homeHarnessChangeKey(revision), false]));

test("an agent's use of its owner's own setup is off unless the stored policy says so in exactly one form", () => {
  assert.deepEqual(OWN_SETUP, { letagentsOwnerIsolation: false });
  for (const [stored, expected] of [
    [{}, false], [OWN_SETUP, true],
    // Every other value of the key leaves the agent isolated.
    [{ [HOME_HARNESS_POLICY_KEY]: true }, false], [{ [HOME_HARNESS_POLICY_KEY]: "false" }, false], [{ [HOME_HARNESS_POLICY_KEY]: 0 }, false],
    [{ [HOME_HARNESS_POLICY_KEY]: null }, false], [{ [HOME_HARNESS_POLICY_KEY]: "" }, false], [{ [HOME_HARNESS_POLICY_KEY]: [] }, false],
    [{ [HOME_HARNESS_POLICY_KEY]: undefined }, false], [{ [HOME_HARNESS_POLICY_KEY]: { enabled: true } }, false],
    // So does every other key, look-alikes and this change's own first form among them.
    [{ letagentsHomeHarness: true }, false], [{ letagentsHomeHarness: false }, false],
    [{ LetagentsOwnerIsolation: false }, false], [{ letagents_owner_isolation: false }, false], [{ "letagents-owner-isolation": false }, false],
    [{ letagentsOwnerIsolation2: false }, false], [{ " letagentsOwnerIsolation": false }, false], [{ ownerIsolation: false }, false],
    [changedAt(4), false],
    [null, false], [undefined, false], [false, false], ["false", false], [[false], false],
  ] as const) {
    assert.equal(storedHomeHarness(stored), expected, JSON.stringify(stored));
  }
  // Text that spells the key with escapes or repeats it is the same key once it is read.
  assert.equal(storedHomeHarness(JSON.parse('{"letagents\\u004fwnerIsolation":false}')), true);
  assert.equal(storedHomeHarness(JSON.parse('{"letagentsOwnerIsolation":false,"letagentsOwnerIsolation":true}')), false, "the last one read is the value");
  // And every one of them is LetAgents' own, so none can be supplied or reach a provider.
  for (const key of ["letagentsOwnerIsolation", "letagentsHomeHarness", "LetagentsOwnerIsolation", "LETAGENTS_OWNER_ISOLATION", "letagents-owner-isolation", "letagentsAnythingElse", homeHarnessChangeKey(7)]) {
    assert.equal(namesHomeHarness({ [key]: false }), true, key);
    assert.deepEqual(withoutHomeHarness({ experimental: true, [key]: false }), { experimental: true }, key);
  }
  // The key never reaches a provider, whatever its value.
  assert.deepEqual(withoutHomeHarness({ experimental: true, [HOME_HARNESS_POLICY_KEY]: "anything" }), { experimental: true });
  const untouched = { experimental: true };
  assert.equal(withoutHomeHarness(untouched), untouched, "a policy without the key is passed through as it is");
  assert.equal(namesHomeHarness({ [HOME_HARNESS_POLICY_KEY]: false }), true);
  assert.equal(namesHomeHarness({}), false);
});

test("LetAgents' own keys are found wherever a policy names them, and a value that is not the policy's own is never the setting", () => {
  // As a request arrives: JSON text gives an object its own `__proto__` property.
  const smuggled = JSON.parse(`{"experimental":true,"__proto__":{"${HOME_HARNESS_POLICY_KEY}":false}}`) as Record<string, unknown>;
  assert.equal(Object.hasOwn(smuggled, "__proto__"), true, "the test did build an own __proto__");
  for (const policy of [
    smuggled,
    { nested: { deeper: [{ [HOME_HARNESS_POLICY_KEY]: false }] } },
    changedAt(3),
    { nested: changedAt(3) },
    JSON.parse(`{"a":{"__proto__":{"${homeHarnessChangeKey(1)}":false}}}`),
  ]) assert.equal(namesHomeHarness(policy), true, JSON.stringify(policy));
  for (const policy of [{ nested: { other: true } }, { __proto__: null }, JSON.parse('{"__proto__":{"other":true}}'), [HOME_HARNESS_POLICY_KEY], HOME_HARNESS_POLICY_KEY]) {
    assert.equal(namesHomeHarness(policy), false, JSON.stringify(policy));
  }
  assert.equal(storedHomeHarness(smuggled), false, "a nested key is not the setting");
  assert.equal(storedHomeHarness(Object.create({ [HOME_HARNESS_POLICY_KEY]: false })), false, "nor is an inherited one");
  assert.equal(agentUsesHomeHarness(agentOn("supervised_abc", "codex"), smuggled), false);
  const cleaned = withoutHomeHarness(smuggled);
  assert.deepEqual(Object.getOwnPropertyNames(cleaned), ["experimental"], "the carrier is dropped before a provider sees the policy");
  assert.equal(Object.getPrototypeOf(cleaned), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyNames(withoutHomeHarness({ keep: 1, ...changedAt(3), ...OWN_SETUP })), ["keep"]);
});

test("a running agent's real state is told apart from the saved choice until it restarts", () => {
  const id = "supervised_abc";
  const policy = (on: boolean, changes: number[]) => ({ ...(on ? OWN_SETUP : {}), ...changedAt(...changes) });
  // Nothing running: only the saved choice matters.
  assert.equal(homeHarnessState(agentOn(id, "codex"), policy(true, [4]), null), "on");
  assert.equal(homeHarnessState(agentOn(id, "codex"), policy(false, [4, 6]), null), null);
  // Turned on at revision 4. A process that started before it does not have the setup yet.
  assert.equal(homeHarnessState(agentOn(id, "codex"), policy(true, [4]), 3), "after_restart");
  assert.equal(homeHarnessState(agentOn(id, "codex"), policy(true, [4]), 4), "on", "a process started at or after the change has it");
  assert.equal(homeHarnessState(agentOn(id, "codex"), policy(true, [4]), 9), "on");
  // Turned off at revision 6. A process that started with it keeps it until it restarts.
  assert.equal(homeHarnessState(agentOn(id, "codex"), policy(false, [4, 6]), 4), "until_restart");
  assert.equal(homeHarnessState(agentOn(id, "codex"), policy(false, [4, 6]), 5), "until_restart");
  assert.equal(homeHarnessState(agentOn(id, "codex"), policy(false, [4, 6]), 6), null, "restarted after it was turned off");
  assert.equal(homeHarnessState(agentOn(id, "codex"), policy(false, [4, 6]), 3), null, "on and off again before it ever restarted: it never had it");
  // Back on at 8 while the process from revision 4 is still running: it has had it all along.
  assert.equal(homeHarnessState(agentOn(id, "codex"), policy(true, [4, 6, 8]), 4), "on");
  assert.equal(homeHarnessState(agentOn(id, "codex"), policy(true, [4, 6, 8]), 7), "after_restart");
  // A process whose starting revision is not known is treated as older than every change.
  assert.equal(homeHarnessState(agentOn(id, "codex"), policy(true, [4]), undefined), "after_restart");
  assert.equal(homeHarnessState(agentOn(id, "codex"), policy(false, [4, 6]), undefined), null);
  // A saved choice with no history is as old as the process.
  assert.equal(homeHarnessState(agentOn(id, "codex"), policy(true, []), 2), "on");
  assert.equal(homeHarnessState(agentOn(id, "codex"), {}, 2), null);
  // A history that cannot be read is no history: the saved choice is shown, never a guess.
  for (const unreadable of [
    { [homeHarnessChangeKey(4)]: true }, { [homeHarnessChangeKey(4)]: null }, { letagentsOwnerIsolationChangedAt: false },
    { letagentsOwnerIsolationChangedAt0: false }, { letagentsOwnerIsolationChangedAt04: false }, { "letagentsOwnerIsolationChangedAt4.5": false },
    { "letagentsOwnerIsolationChangedAt-4": false }, { letagentsOwnerIsolationChangedAt4x: false }, { letagentsHomeHarnessChanges: [4] },
  ]) {
    assert.equal(homeHarnessDiffersFromSaved({ ...OWN_SETUP, ...unreadable }, 1), false, JSON.stringify(unreadable));
  }
  // A rental, Cursor and Open Model never show anything, whatever is stored.
  assert.equal(homeHarnessState(agentOn("supervised_rental_abc", "codex"), policy(true, [4]), 4), null);
  assert.equal(homeHarnessState(agentOn("supervised_rental_abc", "codex"), policy(false, [4, 6]), 4), null);
  assert.equal(homeHarnessState(agentOn(id, "cursor"), policy(true, [4]), 4), null);
  assert.equal(homeHarnessState(agentOn(id, "open-model"), policy(false, [4, 6]), 4), null);
});

test("the roster never shows an agent as rid of the owner's setup while a process that started with it may be alive", () => {
  // Turned on at revision 4 and off at revision 6. The agent last started at revision 4, with the setup.
  const entry = (overrides: Record<string, unknown> = {}) => ({
    id: "supervised_abc", provider: "codex", delivery_mode: "daemon_inbox", provider_launch_policy: changedAt(4, 6), runtime_configuration_revision: 4,
    provider_ref: { work_attempt_id: "attempt" }, observed_state: "idle", ...overrides,
  });
  // The background service holds the process.
  assert.equal(homeHarnessRosterState(entry(), { startedAtRevision: 4 }), "until_restart");
  assert.equal(homeHarnessRosterState(entry(), { startedAtRevision: 6 }), null, "its successor does not have it");
  assert.equal(homeHarnessRosterState(entry(), { startedAtRevision: undefined }), "until_restart", "a held process of unknown age is read from the agent's last start");
  // It was restarted and has not re-attached the process yet. The process may well be running.
  // A paused agent is among them: it is marked paused when its process's end is recorded, but one route
  // marks it with no such record, so the read model asks for the record before it drops the reference.
  for (const state of ["idle", "working", "starting", "stopping", "recovering", "checkpointing", "paused", "pausing"]) {
    assert.equal(homeHarnessRosterState(entry({ observed_state: state }), null), "until_restart", state);
  }
  // Only when the process is known gone, or there never was one, does the saved choice stand alone.
  for (const state of ["stopped", "failed", "absent"]) {
    assert.equal(homeHarnessRosterState(entry({ observed_state: state }), null), null, state);
  }
  assert.equal(homeHarnessRosterState(entry({ provider_ref: undefined }), null), null);
  assert.equal(homeHarnessRosterState(entry({ runtime_configuration_revision: 6 }), null), null, "it last started after the setup was turned off");
  // The other direction: saved on, and a process that may be alive started without it.
  const on = { ...OWN_SETUP, ...changedAt(4) };
  assert.equal(homeHarnessRosterState(entry({ provider_launch_policy: on, runtime_configuration_revision: 3 }), null), "after_restart");
  assert.equal(homeHarnessRosterState(entry({ provider_launch_policy: on, runtime_configuration_revision: 3, observed_state: "stopped" }), null), "on");
  assert.equal(homeHarnessRosterState(entry({ id: "supervised_rental_abc" }), { startedAtRevision: 4 }), null);
});

test("whether a process was started with the owner's setup is the daemon's own record, and a record that cannot be read says no", () => {
  const entry = (policy: unknown, overrides: Record<string, unknown> = {}) => ({
    id: "supervised_abc", provider: "codex", delivery_mode: "daemon_inbox", provider_launch_policy: policy, runtime_configuration_revision: 4, ...overrides,
  });
  // An agent that never had the setup has no record of it at all.
  for (const never of [{}, { approvalPolicy: "never" }, undefined]) {
    assert.equal(startedWithHomeHarness(entry(never)), false);
    assert.deepEqual(ownerSetupRef(entry(never)), {}, "and its reference carries no key");
  }
  assert.equal(startedWithHomeHarness(entry({ ...OWN_SETUP, ...changedAt(4) })), true);
  assert.deepEqual(ownerSetupRef(entry({ ...OWN_SETUP, ...changedAt(4) })), { ownerSetup: true });
  assert.equal(startedWithHomeHarness(entry(changedAt(5))), true, "turned off since: the process still has it");
  assert.equal(startedWithHomeHarness(entry({ ...OWN_SETUP, ...changedAt(5) })), false, "turned on since: the process does not have it yet");
  assert.equal(startedWithHomeHarness(entry(changedAt(5, 6))), false, "on and off again since: it never had it");
  // A stored policy that is not a plain object, or a value that is not the exact one, is not read as on.
  // A launch reads the same record the same way (agentUsesHomeHarness), so such an agent starts isolated.
  for (const unreadable of [null, "letagentsOwnerIsolation", ["letagentsOwnerIsolation"], 7, { letagentsOwnerIsolation: true },
    { letagentsOwnerIsolation: "false" }, { letagentsOwnerIsolation: null }, Object.create({ letagentsOwnerIsolation: false })]) {
    assert.equal(startedWithHomeHarness(entry(unreadable)), false, JSON.stringify(unreadable));
    assert.equal(agentUsesHomeHarness({ id: "supervised_abc", provider: "codex", deliveryMode: "daemon_inbox" }, unreadable), false, JSON.stringify(unreadable));
  }
  // A stored policy that is there but is not an object at all cannot say how the process was started.
  // Its reference says so, which keeps the process from being asked to read its project again; nothing else changes.
  for (const unreadable of ["letagentsOwnerIsolation", ["letagentsOwnerIsolation"], 7, true, Object.create({ letagentsOwnerIsolation: false })]) {
    assert.deepEqual(ownerSetupRef(entry(unreadable)), { ownerSetup: "unknown" }, JSON.stringify(unreadable));
  }
  // A readable record without the setup carries nothing, whatever else it holds, and nor does a row with no policy stored.
  for (const readable of [{}, { approvalPolicy: "never" }, { letagentsOwnerIsolation: true }, { letagentsOwnerIsolation: "false" }, changedAt(3), undefined, null]) {
    assert.deepEqual(ownerSetupRef(entry(readable)), {}, JSON.stringify(readable));
  }
  // An agent that may not have the setup never has it, whatever is stored.
  for (const overrides of [{ id: "supervised_rental_abc" }, { provider: "cursor" }, { provider: "open-model" }, { delivery_mode: "mcp_polling" }, { delivery_mode: undefined }]) {
    assert.equal(startedWithHomeHarness(entry({ ...OWN_SETUP, ...changedAt(4) }, overrides)), false, JSON.stringify(overrides));
  }
});

test("a save keeps the history of changes a running process may predate, and records a new one only for a change", () => {
  const snapshot = (homeHarness: boolean) => ({ launchPolicy: { approvalPolicy: "never" }, ...(homeHarness ? { homeHarness: true as const } : {}) });
  // Turned on at revision 4 while the process from revision 2 runs.
  const on = storedLaunchPolicy(snapshot(true), { policy: {}, runtimeRevision: 2, changedAt: 4 });
  assert.deepEqual(on, { approvalPolicy: "never", letagentsOwnerIsolation: false, letagentsOwnerIsolationChangedAt4: false });
  // An ordinary save carries the choice and the history forward as they are.
  assert.deepEqual(storedLaunchPolicy(snapshot(true), { policy: on }), on);
  // Turned off at 6, still the same process: both changes are kept, and they cancel for it.
  const off = storedLaunchPolicy(snapshot(false), { policy: on, runtimeRevision: 2, changedAt: 6 });
  assert.deepEqual(off, { approvalPolicy: "never", ...changedAt(4, 6) });
  assert.equal(homeHarnessDiffersFromSaved(off, 2), false);
  // A change the running process already started after is no longer needed.
  assert.deepEqual(storedLaunchPolicy(snapshot(false), { policy: on, runtimeRevision: 5, changedAt: 6 }),
    { approvalPolicy: "never", ...changedAt(6) });
  // With no earlier policy nothing is recorded: a fresh derive stores the native options alone.
  assert.deepEqual(storedLaunchPolicy(snapshot(false)), { approvalPolicy: "never" });
  // The history never grows without bound, and dropping the oldest in pairs keeps the answer for an old process.
  let policy: Record<string, unknown> = {};
  for (let revision = 2; revision < 2 + 41; revision += 1) {
    policy = storedLaunchPolicy(snapshot(revision % 2 === 0), { policy, runtimeRevision: 1, changedAt: revision });
  }
  const changes = Object.keys(policy).filter((key) => key.startsWith("letagentsOwnerIsolationChangedAt"));
  assert.equal(changes.length <= 32, true);
  assert.equal(Object.hasOwn(policy, homeHarnessChangeKey(42)), true);
  // Whatever is stored, every value LetAgents keeps is exactly false: the one form an older build drops.
  for (const [key, value] of Object.entries(policy)) if (key.startsWith("letagents")) assert.equal(value, false, key);
  assert.equal(storedHomeHarness(policy), true, "41 changes from off leave it on");
  assert.equal(homeHarnessDiffersFromSaved(policy, 1), true, "and the process from before them all still runs without it");
});

test("the owner's own setup is offered only for an owner's Codex and Claude Code agents, never a rental", () => {
  assert.equal(homeHarnessAvailability(agentOn("supervised_abc", "codex")), "available");
  assert.equal(homeHarnessAvailability(agentOn("supervised_abc", "claude-code")), "available");
  assert.equal(homeHarnessAvailability(agentOn("supervised_abc", "cursor")), "unsupported");
  assert.equal(homeHarnessAvailability(agentOn("supervised_abc", "open-model")), "unsupported");
  for (const provider of ["codex", "claude-code", "cursor", "open-model"]) {
    assert.equal(homeHarnessAvailability(agentOn("supervised_rental_abc", provider)), "rental");
  }
  const stored = { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, ...OWN_SETUP };
  assert.equal(agentUsesHomeHarness(agentOn("supervised_abc", "codex"), stored), true);
  assert.equal(agentUsesHomeHarness(agentOn("supervised_abc", "codex"), {}), false);
  assert.equal(agentUsesHomeHarness(agentOn("supervised_rental_abc", "codex"), stored), false, "a rental never shows or uses it");
  assert.equal(agentUsesHomeHarness(agentOn("supervised_abc", "cursor"), stored), false);
  assert.equal(agentUsesHomeHarness(agentOn("supervised_abc", "open-model"), stored), false);
  assert.equal(entryLaunchPolicy(agentOn("supervised_abc", "codex"), stored), stored);
  assert.deepEqual(entryLaunchPolicy(agentOn("supervised_rental_abc", "codex"), stored),
    { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }, "a rental launches without it whatever is stored");
  assert.deepEqual(entryLaunchPolicy(agentOn("supervised_abc", "cursor"), { force: true, sandbox: "enabled", ...OWN_SETUP }),
    { force: true, sandbox: "enabled" });
});

test("an agent that collects its own room messages never gets the owner's own setup, whatever is stored", () => {
  const stored = { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, ...OWN_SETUP, ...changedAt(4) };
  // The daemon can hold an agent back from its next turn only when it delivers the room's messages itself.
  for (const deliveryMode of ["mcp_polling", "desktop_events", undefined, null, "", "DAEMON_INBOX", "daemon_inbox "]) {
    for (const provider of ["codex", "claude-code"]) {
      const agent = { id: "supervised_abc", provider, deliveryMode };
      assert.equal(homeHarnessAvailability(agent), "polling", `${provider}/${String(deliveryMode)}`);
      assert.equal(agentUsesHomeHarness(agent, stored), false);
      assert.deepEqual(entryLaunchPolicy(agent, stored), { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }, "its launch reads the stored value as off");
      assert.equal(homeHarnessState(agent, stored, 4), null);
    }
  }
  assert.equal(homeHarnessAvailability(agentOn("supervised_abc", "codex", "daemon_inbox")), "available");
  // A rental and an agent app with no owner setup are named as such first.
  assert.equal(homeHarnessAvailability(agentOn("supervised_rental_abc", "codex", "mcp_polling")), "rental");
  assert.equal(homeHarnessAvailability(agentOn("supervised_abc", "cursor", "mcp_polling")), "unsupported");
  // And the roster never marks it, with or without a running process.
  const entry = { id: "supervised_abc", provider: "codex", delivery_mode: "mcp_polling", provider_launch_policy: stored,
    runtime_configuration_revision: 4, provider_ref: { work_attempt_id: "attempt" }, observed_state: "idle" };
  assert.equal(homeHarnessRosterState(entry, { startedAtRevision: 4 }), null);
  assert.equal(homeHarnessRosterState(entry, null), null);
  assert.equal(homeHarnessRosterState({ ...entry, delivery_mode: undefined }, { startedAtRevision: 4 }), null);
  assert.equal(homeHarnessRosterState({ ...entry, delivery_mode: "daemon_inbox" }, { startedAtRevision: 4 }), "on");
});

test("a snapshot names the owner's own setup beside a native policy that never carries the key", () => {
  const off = deriveProviderConfigurationSnapshot({
    provider: "codex", model: null, reasoningEffort: null, permissionProfileId: "ask_before_write", configurationRevision: 2,
  }, {});
  assert.equal(Object.hasOwn(off, "homeHarness"), false, "off leaves the snapshot exactly as it was");
  const on = deriveProviderConfigurationSnapshot({
    provider: "codex", model: null, reasoningEffort: null, permissionProfileId: "ask_before_write", configurationRevision: 2,
  }, { experimental: true, ...OWN_SETUP });
  assert.equal(on.homeHarness, true);
  assert.deepEqual(on.launchPolicy, { ...off.launchPolicy, experimental: true }, "Codex's native policy is the same either way");
  assert.deepEqual(storedLaunchPolicy(on), { ...on.launchPolicy, ...OWN_SETUP }, "the choice survives a save");
  assert.deepEqual(storedLaunchPolicy(off), off.launchPolicy);
  assert.deepEqual(storedLaunchPolicy({ launchPolicy: { ...off.launchPolicy, ...OWN_SETUP } }), off.launchPolicy,
    "only the snapshot's own answer puts the key back");

  // Cursor and Open Model have no owner setup to load: the key is dropped, and Cursor's strict policy still validates.
  for (const [provider, permissionProfileId] of [["cursor", "sandboxed_write"], ["open-model", "full_access"]] as const) {
    const unsupported = deriveProviderConfigurationSnapshot({
      provider, model: null, reasoningEffort: null, permissionProfileId, configurationRevision: 2,
    }, OWN_SETUP);
    assert.equal(Object.hasOwn(unsupported, "homeHarness"), false, provider);
    assert.equal(namesHomeHarness(unsupported.launchPolicy), false, provider);
    assert.equal(namesHomeHarness(storedLaunchPolicy(unsupported)), false, provider);
  }
});

test("Claude reads the owner's user settings and Skill tool only with the owner's own setup", () => {
  const claude = (permissionProfileId: string, stored: Record<string, unknown>) => deriveProviderConfigurationSnapshot({
    provider: "claude-code", model: null, reasoningEffort: null, permissionProfileId, configurationRevision: 4,
  }, stored);
  const tools = ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"];
  for (const profile of ["ask_before_write", "auto_review"]) {
    const off = claude(profile, {});
    const on = claude(profile, OWN_SETUP);
    assert.deepEqual(off.launchPolicy.tools, tools, profile);
    assert.equal(off.launchPolicy.settingSources, "", profile);
    assert.deepEqual(on.launchPolicy, { ...off.launchPolicy, tools: [...tools, "Skill"], settingSources: "user" }, profile);
    assert.equal(on.homeHarness, true);
    // Turning it off again restores exactly the isolated policy.
    assert.deepEqual(claude(profile, withoutHomeHarness(storedLaunchPolicy(on))), off, profile);
    // The stored policy keeps the choice across a later edit of another setting.
    assert.deepEqual(claude(profile, storedLaunchPolicy(on)), on, profile);
  }
  const readOnlyOff = claude("read_only", {});
  const readOnlyOn = claude("read_only", OWN_SETUP);
  assert.deepEqual(readOnlyOn.launchPolicy, { ...readOnlyOff.launchPolicy, settingSources: "user" });
  assert.deepEqual(readOnlyOn.launchPolicy.tools, ["Read", "Glob", "Grep"], "a read-only agent gains no tool");
  assert.deepEqual(claude("full_access", OWN_SETUP).launchPolicy, claude("full_access", {}).launchPolicy,
    "full access already reads every setting; only the adapter's MCP flag differs");
  // Changing the access level with the setup on moves between the right policies.
  assert.deepEqual(claude("full_access", storedLaunchPolicy(claude("ask_before_write", OWN_SETUP))).launchPolicy,
    { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true });
  assert.deepEqual(claude("ask_before_write", storedLaunchPolicy(claude("full_access", OWN_SETUP))).launchPolicy,
    claude("ask_before_write", OWN_SETUP).launchPolicy);
});

test("Claude's access levels are described truthfully for an agent that uses its owner's settings", () => {
  const profiles = supervisedPermissionProfilesForProvider("claude-code");
  assert.ok(profiles.some((profile) => profile.detail?.includes("Other Claude settings do not apply.")));
  const described = describeProfilesWithOwnerSetup("claude-code", profiles) as typeof profiles;
  const text = (list: typeof profiles, id: string) => { const profile = list.find((item) => item.id === id)!; return `${profile.description} ${profile.detail}`; };
  assert.equal(described.some((profile) => profile.detail?.includes("Other Claude settings do not apply.")), false);
  // An approval is no longer promised for everything: the owner's own allow rules can let the agent act without one.
  assert.match(text(described, "ask_before_write"), /^Asks before Claude changes files or runs write-capable commands, unless your own Claude Code rules already allow them\./);
  assert.match(text(described, "ask_before_write"), /Your own Claude Code allow rules apply too, and can let the agent act without asking you\. Your hooks run as you set them up\./);
  assert.doesNotMatch(text(described, "ask_before_write"), /^Requires approval before/);
  assert.match(text(described, "auto_review"), /Your own Claude Code allow rules apply first, and your hooks run as you set them up\./);
  // Read-only keeps its own tools read-only and says what of the owner's can still act. It promises no skill.
  assert.match(text(described, "read_only"), /the MCP tools your own Claude Code rules allow\. Its own tools cannot change files or run commands\. Your MCP tools and hooks can, where your own Claude Code settings allow them\. Nothing asks you\./);
  assert.doesNotMatch(text(described, "read_only"), /skill/i);
  // Full access withholds nothing, but with the owner's setup on the project's own Claude setup stays out, and the text says so.
  assert.equal(described.find((profile) => profile.id === "full_access")!.description, profiles.find((profile) => profile.id === "full_access")!.description);
  assert.match(text(described, "full_access"), /While your own setup is on, the project's own Claude settings, hooks, skills, commands and MCP servers are not loaded\. Its CLAUDE\.md still is\.$/);
  assert.deepEqual(described.find((profile) => profile.id === "sandboxed_write"), profiles.find((profile) => profile.id === "sandboxed_write"), "a level the agent cannot use is left as it is");
  assert.deepEqual(describeProfilesWithOwnerSetup("claude", profiles), described);

  // Codex's own limits bind Codex's commands. The owner's tools, hooks and plugins are outside them, and the text says so.
  const codex = supervisedPermissionProfilesForProvider("codex");
  const codexDescribed = describeProfilesWithOwnerSetup("codex", codex) as typeof codex;
  for (const id of ["ask_before_write", "auto_review"]) {
    assert.match(text(codexDescribed, id), /Your own MCP tools, hooks and plugins are not held to these limits: they run as you/, id);
    assert.equal(text(codexDescribed, id).startsWith(text(codex, id).slice(0, 60)), true, `${id}: what Codex's own commands may do is unchanged`);
  }
  assert.deepEqual(codexDescribed.find((profile) => profile.id === "full_access"), codex.find((profile) => profile.id === "full_access"));
  assert.deepEqual(codexDescribed.filter((profile) => profile.status !== "available"), codex.filter((profile) => profile.status !== "available"));
  // Agent apps that never get the owner's setup are never redescribed, and neither is anything unreadable.
  for (const provider of ["cursor", "open-model"]) {
    const untouched = supervisedPermissionProfilesForProvider(provider);
    assert.deepEqual(describeProfilesWithOwnerSetup(provider, untouched), untouched, provider);
  }
  assert.equal(describeProfilesWithOwnerSetup("claude-code", null), null);
});

test("the daemon's policy for each access level is the one the adapters attest, with and without the owner's own setup", () => {
  for (const [provider, profiles] of [
    ["codex", ["full_access", "ask_before_write", "auto_review"]],
    ["claude-code", ["read_only", "ask_before_write", "auto_review", "full_access"]],
  ] as const) {
    for (const profile of profiles) {
      for (const homeHarness of [false, true]) {
        const snapshot = deriveProviderConfigurationSnapshot({
          provider, model: null, reasoningEffort: null, permissionProfileId: profile, configurationRevision: 3,
        }, homeHarness ? OWN_SETUP : {});
        assert.equal(snapshot.homeHarness === true, homeHarness);
        assert.deepEqual(attestProviderSpawnPolicy(provider, {
          workAttemptId: "attempt", roomId: "room", cwd: "/tmp/attempt", model: null, reasoningEffort: null,
          permissionProfileId: profile, configurationRevision: 3, deliveryMode: "daemon_inbox",
          launchPolicy: snapshot.launchPolicy, ...(snapshot.homeHarness ? { homeHarness: true } : {}),
        }), snapshot.launchPolicy, `${provider}/${profile}/${homeHarness}`);
      }
    }
  }
});

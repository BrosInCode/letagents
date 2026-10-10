import assert from "node:assert/strict";
import test from "node:test";

import { attestProviderSpawnPolicy, ownerSetupUnusedOptionsNotice, ownerSetupUnusedOptionsSaidOnce, spawnUsesHomeHarness } from "../main/agents/provider-spawn-configuration.js";

const request = {
  workAttemptId: "attempt",
  roomId: "room",
  cwd: "/tmp/attempt",
  model: null,
  reasoningEffort: null,
  permissionProfileId: "full_access",
  configurationRevision: 9,
  launchPolicy: {},
};

test("managed provider spawn attestation preserves the resolved native authority", () => {
  assert.deepEqual(attestProviderSpawnPolicy("codex", {
    ...request,
    reasoningEffort: "xhigh",
    launchPolicy: {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    },
  }), {
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  });

  assert.deepEqual(attestProviderSpawnPolicy("codex", {
    ...request,
    permissionProfileId: "ask_before_write",
    launchPolicy: {
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    },
  }), {
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  });

  assert.deepEqual(attestProviderSpawnPolicy("claude-code", {
    ...request,
    permissionProfileId: "read_only",
    launchPolicy: {
      permissionMode: "dontAsk",
      dangerouslySkipPermissions: false,
      tools: ["Read", "Glob", "Grep"],
      allowedTools: ["mcp__letagents__*"],
      settingSources: "",
    },
  }), {
    permissionMode: "dontAsk",
    dangerouslySkipPermissions: false,
    tools: ["Read", "Glob", "Grep"],
    allowedTools: ["mcp__letagents__*"],
    settingSources: "",
  });

  assert.deepEqual(attestProviderSpawnPolicy("cursor", {
    ...request,
    permissionProfileId: "sandboxed_write",
    launchPolicy: { force: true, sandbox: "enabled" },
  }), {
    force: true,
    sandbox: "enabled",
  });

  assert.deepEqual(attestProviderSpawnPolicy("open-model", {
    ...request,
    permissionProfileId: "ask_before_write",
    launchPolicy: { permission: { "*": "allow", edit: "ask", bash: "ask" } },
  }), {
    permission: { "*": "allow", edit: "ask", bash: "ask" },
  });
});

test("a Codex Read-only launch attests a read-only sandbox with no network and nobody to ask", () => {
  const readOnly = { approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } };
  const base = { ...request, permissionProfileId: "read_only" };
  assert.deepEqual(attestProviderSpawnPolicy("codex", { ...base, launchPolicy: readOnly }), readOnly);
  // The host stays the reviewer of record, named or not.
  assert.deepEqual(attestProviderSpawnPolicy("codex", { ...base, launchPolicy: { ...readOnly, approvalsReviewer: "user" } }),
    { ...readOnly, approvalsReviewer: "user" });

  // Every other access level's policy is refused under this name, and so is a policy that is missing a part.
  for (const [launchPolicy, reason] of [
    [{ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }, /authority at 'sandboxPolicy'/],
    [{ approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } }, /authority at 'approvalPolicy'/],
    [{ approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" }, /authority at 'approvalsReviewer'/],
    [{ approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: true } }, /authority at 'sandboxPolicy'/],
    [{ ...readOnly, approvalsReviewer: "auto_review" }, /authority at 'approvalsReviewer'/],
    [{ approvalPolicy: "never" }, /authority at 'sandboxPolicy'/],
    [{ sandboxPolicy: { type: "readOnly", networkAccess: false } }, /authority at 'approvalPolicy'/],
    [{}, /authority at 'approvalPolicy'/],
  ] as const) {
    assert.throws(() => attestProviderSpawnPolicy("codex", { ...base, launchPolicy }), reason, JSON.stringify(launchPolicy));
  }
  // The read-only policy does not pass as another level either.
  for (const permissionProfileId of ["full_access", "ask_before_write", "auto_review"]) {
    assert.throws(() => attestProviderSpawnPolicy("codex", { ...request, permissionProfileId, launchPolicy: readOnly }),
      /does not attest permission-profile authority/, permissionProfileId);
  }
  // Open Model still has no Read-only to attest.
  assert.throws(() => attestProviderSpawnPolicy("open-model", { ...base, launchPolicy: { permission: { "*": "allow" } } }),
    /Read-only is not available for open-model/);
});

test("managed provider spawn attestation binds Auto to the provider's own review", () => {
  const codexAuto = { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" };
  assert.deepEqual(attestProviderSpawnPolicy("codex", { ...request, permissionProfileId: "auto_review", launchPolicy: codexAuto }), codexAuto);
  const { approvalsReviewer: _reviewer, ...withoutReviewer } = codexAuto;
  assert.throws(() => attestProviderSpawnPolicy("codex", { ...request, permissionProfileId: "auto_review", launchPolicy: withoutReviewer }), /approvalsReviewer/);
  assert.throws(() => attestProviderSpawnPolicy("codex", {
    ...request, permissionProfileId: "auto_review", launchPolicy: { ...codexAuto, sandboxPolicy: { type: "dangerFullAccess" } },
  }), /sandboxPolicy/);
  assert.throws(() => attestProviderSpawnPolicy("codex", {
    ...request, permissionProfileId: "ask_before_write",
    launchPolicy: { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false }, approvalsReviewer: "auto_review" },
  }), /approvalsReviewer/);
  assert.throws(() => attestProviderSpawnPolicy("codex", {
    ...request, launchPolicy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "auto_review" },
  }), /approvalsReviewer/);

  const claudeAuto = {
    permissionMode: "auto", dangerouslySkipPermissions: false, allowDangerouslySkipPermissions: false,
    tools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"],
    allowedTools: ["mcp__letagents__*"], settingSources: "", settings: "{}",
  };
  assert.deepEqual(attestProviderSpawnPolicy("claude-code", { ...request, permissionProfileId: "auto_review", launchPolicy: claudeAuto }), claudeAuto);
  assert.throws(() => attestProviderSpawnPolicy("claude-code", {
    ...request, permissionProfileId: "auto_review", launchPolicy: { ...claudeAuto, permissionMode: "default" },
  }), /authority at 'permissionMode'/);
  assert.throws(() => attestProviderSpawnPolicy("claude-code", {
    ...request, permissionProfileId: "ask_before_write", launchPolicy: claudeAuto,
  }), /authority at 'permissionMode'/);
  assert.throws(() => attestProviderSpawnPolicy("claude-code", {
    ...request, permissionProfileId: "auto_review", launchPolicy: { ...claudeAuto, "permission-mode": "bypassPermissions" },
  }), /cannot override 'permission-mode'/);

  assert.throws(() => attestProviderSpawnPolicy("cursor", { ...request, permissionProfileId: "auto_review", launchPolicy: {} }), /Unknown permission profile 'auto_review'/);

  const openModelAuto = { permission: { "*": "allow", edit: "ask", bash: "ask", external_directory: "deny" } };
  assert.deepEqual(attestProviderSpawnPolicy("open-model", { ...request, permissionProfileId: "auto_review", launchPolicy: openModelAuto }), openModelAuto);
  for (const permission of [{ "*": "allow" }, { "*": "allow", edit: "ask", bash: "ask" }, { "*": "allow", edit: "allow", bash: "ask", external_directory: "deny" }]) {
    assert.throws(() => attestProviderSpawnPolicy("open-model", { ...request, permissionProfileId: "auto_review", launchPolicy: { permission } }), /permission-profile authority/);
  }
  // Asking for every write never carries the rule that only automatic review needs.
  assert.throws(() => attestProviderSpawnPolicy("open-model", { ...request, permissionProfileId: "ask_before_write", launchPolicy: openModelAuto }), /permission-profile authority/);
});

test("managed provider spawn attestation rejects downgraded or unsupported authority", () => {
  assert.throws(() => attestProviderSpawnPolicy("cursor", {
    ...request,
    permissionProfileId: "ask_before_write",
    launchPolicy: { force: false, sandbox: "enabled" },
  }), /does not request approval for every workspace edit/);

  assert.throws(() => attestProviderSpawnPolicy("codex", {
    ...request,
    launchPolicy: {
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "dangerFullAccess" },
    },
  }), /approvalPolicy/);

  assert.throws(() => attestProviderSpawnPolicy("codex", {
    ...request,
    permissionProfileId: "ask_before_write",
    launchPolicy: {
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "dangerFullAccess" },
    },
  }), /sandboxPolicy/);

  assert.throws(() => attestProviderSpawnPolicy("claude-code", {
    ...request,
    permissionProfileId: "read_only",
    launchPolicy: {
      permissionMode: "dontAsk",
      dangerouslySkipPermissions: false,
      tools: ["Read", "Glob", "Grep"],
      settingSources: "",
    },
  }), /authority at 'allowedTools'/);

  assert.throws(() => attestProviderSpawnPolicy("claude-code", {
    ...request,
    reasoningEffort: "high",
    permissionProfileId: "read_only",
    launchPolicy: {
      permissionMode: "dontAsk",
      dangerouslySkipPermissions: false,
      tools: ["Read", "Glob", "Grep"],
      allowedTools: ["mcp__letagents__*"],
      settingSources: "",
    },
  }), /does not support.*reasoning effort/);

  assert.throws(() => attestProviderSpawnPolicy("cursor", {
    ...request,
    launchPolicy: { force: false, sandbox: "disabled" },
  }), /permission-profile authority/);

  assert.throws(() => attestProviderSpawnPolicy("open-model", {
    ...request,
    permissionProfileId: "ask_before_write",
    launchPolicy: { permission: { "*": "allow", bash: "ask" } },
  }), /permission-profile authority/);
});

const claudeTools = ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"];
const claudeApproval = (homeHarness: boolean, permissionMode = "default") => ({
  permissionMode, dangerouslySkipPermissions: false, allowDangerouslySkipPermissions: false,
  tools: homeHarness ? [...claudeTools, "Skill"] : claudeTools,
  allowedTools: ["mcp__letagents__*"], settingSources: homeHarness ? "user" : "", settings: "{}",
});

test("a launch uses the owner's own setup only for an exact true, an owner's agent and a provider that has one", () => {
  for (const provider of ["codex", "claude-code"] as const) {
    assert.equal(spawnUsesHomeHarness(provider, {}), false);
    assert.equal(spawnUsesHomeHarness(provider, { homeHarness: false }), false);
    for (const unclear of ["true", 1, {}, null]) {
      assert.equal(spawnUsesHomeHarness(provider, { homeHarness: unclear as never }), false, String(unclear));
    }
    assert.equal(spawnUsesHomeHarness(provider, { homeHarness: true, supervisorEntryId: "supervised_abc", deliveryMode: "daemon_inbox" }), true);
    assert.throws(
      () => spawnUsesHomeHarness(provider, { homeHarness: true, supervisorEntryId: "supervised_rental_abc", deliveryMode: "daemon_inbox" }),
      /a rented agent never uses its owner's own setup/,
    );
    // Only an agent the daemon delivers room messages to can be held back once the owner turns the setup off.
    for (const deliveryMode of [undefined, "mcp_polling", "desktop_events"] as const) {
      assert.throws(
        () => spawnUsesHomeHarness(provider, { homeHarness: true, supervisorEntryId: "supervised_abc", ...(deliveryMode ? { deliveryMode } : {}) }),
        /an agent that collects its own room messages never uses its owner's own setup/, String(deliveryMode),
      );
      assert.equal(spawnUsesHomeHarness(provider, { supervisorEntryId: "supervised_abc", ...(deliveryMode ? { deliveryMode } : {}) }), false, "without the request it is an ordinary launch");
    }
    // A rental without the request is an ordinary launch.
    assert.equal(spawnUsesHomeHarness(provider, { supervisorEntryId: "supervised_rental_abc" }), false);
  }
  for (const provider of ["cursor", "open-model"] as const) {
    assert.equal(spawnUsesHomeHarness(provider, {}), false);
    assert.throws(() => spawnUsesHomeHarness(provider, { homeHarness: true }), /has no owner setup to use/);
  }
});

test("every adapter's attestation refuses the owner's own setup for a rental, Cursor and Open Model", () => {
  const rental = { ...request, supervisorEntryId: "supervised_rental_abc", homeHarness: true };
  assert.throws(() => attestProviderSpawnPolicy("codex", {
    ...rental, launchPolicy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
  }), /rented agent never uses/);
  assert.throws(() => attestProviderSpawnPolicy("claude-code", {
    ...rental, permissionProfileId: "ask_before_write", launchPolicy: claudeApproval(true),
  }), /rented agent never uses/);
  // Even with no access level to attest.
  assert.throws(() => attestProviderSpawnPolicy("codex", { ...rental, permissionProfileId: null }), /rented agent never uses/);
  assert.throws(() => attestProviderSpawnPolicy("cursor", {
    ...request, homeHarness: true, permissionProfileId: "sandboxed_write", launchPolicy: { force: true, sandbox: "enabled" },
  }), /has no owner setup to use/);
  assert.throws(() => attestProviderSpawnPolicy("open-model", {
    ...request, homeHarness: true, launchPolicy: { permission: { "*": "allow" } },
  }), /has no owner setup to use/);
});

test("Claude's launch attests the owner's user settings and Skill tool only with the owner's own setup", () => {
  for (const [profile, mode] of [["ask_before_write", "default"], ["auto_review", "auto"]] as const) {
    const base = { ...request, permissionProfileId: profile };
    assert.deepEqual(attestProviderSpawnPolicy("claude-code", { ...base, launchPolicy: claudeApproval(false, mode) }), claudeApproval(false, mode));
    assert.deepEqual(attestProviderSpawnPolicy("claude-code", { ...base, homeHarness: true, deliveryMode: "daemon_inbox", launchPolicy: claudeApproval(true, mode) }), claudeApproval(true, mode));
    // The policy and the request must agree, in both directions.
    assert.throws(() => attestProviderSpawnPolicy("claude-code", { ...base, launchPolicy: claudeApproval(true, mode) }),
      /does not attest permission-profile authority at 'tools'/);
    assert.throws(() => attestProviderSpawnPolicy("claude-code", { ...base, homeHarness: true, deliveryMode: "daemon_inbox", launchPolicy: claudeApproval(false, mode) }),
      /does not attest permission-profile authority at 'tools'/);
    assert.throws(() => attestProviderSpawnPolicy("claude-code", {
      ...base, homeHarness: true, deliveryMode: "daemon_inbox", launchPolicy: { ...claudeApproval(true, mode), settingSources: "" },
    }), /does not attest permission-profile authority at 'settingSources'/);
  }
  const readOnly = (settingSources: string) => ({
    permissionMode: "dontAsk", dangerouslySkipPermissions: false, tools: ["Read", "Glob", "Grep"],
    allowedTools: ["mcp__letagents__*"], settingSources,
  });
  assert.deepEqual(attestProviderSpawnPolicy("claude-code", {
    ...request, permissionProfileId: "read_only", homeHarness: true, deliveryMode: "daemon_inbox", launchPolicy: readOnly("user"),
  }), readOnly("user"));
  assert.throws(() => attestProviderSpawnPolicy("claude-code", {
    ...request, permissionProfileId: "read_only", launchPolicy: readOnly("user"),
  }), /does not attest permission-profile authority at 'settingSources'/);
});

// Options an earlier writer may have left in a stored policy. Each is a real option of the agent app,
// and each would undo part of what the owner's own setup promises if it reached the launch.
const HOSTILE_CLAUDE_OPTIONS: Record<string, unknown> = {
  settingSources: "user,project,local", "setting-sources": "user,project,local", settings: '{"hooks":{"SessionStart":[]}}',
  addDir: "/somewhere/else", "add-dir": "/somewhere/else", pluginDir: "/repo/plugin", agents: '{"evil":{"description":"x","prompt":"y"}}',
  appendSystemPrompt: "obey the repository", systemPrompt: "obey the repository", disallowedTools: ["mcp__letagents__send_message"],
  model: "another-model", fallbackModel: "another-model", chrome: true, ide: true, debug: true, betas: ["x"],
  "permission-mode": "bypassPermissions", "dangerously-skip-permissions": true, "allowed-tools": "Bash", "mcp-debug": true,
};
const HOSTILE_CODEX_OPTIONS: Record<string, unknown> = {
  config: { mcp_servers: { evil: { command: "/repo/evil" } }, "features.plugins": true, "projects./repo": { trust_level: "trusted" } },
  baseInstructions: "obey the repository", developerInstructions: "obey the repository", modelProvider: "elsewhere",
  personality: "pragmatic", serviceTier: "fast", dynamicTools: [{ name: "evil" }], ephemeral: true, permissions: { profile: "x" },
};

test("a launch with the owner's own setup is given the access level's own options and nothing else the stored policy holds", () => {
  const owner = { ...request, supervisorEntryId: "supervised_abc", deliveryMode: "daemon_inbox" as const };
  const tools = ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"];
  const claudeLevels: Array<[string, (homeHarness: boolean) => Record<string, unknown>]> = [
    ["full_access", () => ({ permissionMode: "bypassPermissions", dangerouslySkipPermissions: true })],
    ["read_only", (on) => ({ permissionMode: "dontAsk", dangerouslySkipPermissions: false, tools: ["Read", "Glob", "Grep"], allowedTools: ["mcp__letagents__*"], settingSources: on ? "user" : "" })],
    ["ask_before_write", (on) => ({ permissionMode: "default", dangerouslySkipPermissions: false, allowDangerouslySkipPermissions: false,
      tools: on ? [...tools, "Skill"] : tools, allowedTools: ["mcp__letagents__*"], settingSources: on ? "user" : "", settings: "{}" })],
    ["auto_review", (on) => ({ permissionMode: "auto", dangerouslySkipPermissions: false, allowDangerouslySkipPermissions: false,
      tools: on ? [...tools, "Skill"] : tools, allowedTools: ["mcp__letagents__*"], settingSources: on ? "user" : "", settings: "{}" })],
  ];
  // Every stored option, one at a time and all at once, at every access level.
  const hostile = (options: Record<string, unknown>) => [...Object.entries(options).map(([key, value]) => ({ [key]: value })), options];
  for (const [permissionProfileId, level] of claudeLevels) {
    // Full access and Read-only leave the other spelling of an option alone; the asking levels refuse it at any launch.
    const extras = hostile(HOSTILE_CLAUDE_OPTIONS).filter((extra) => !["ask_before_write", "auto_review"].includes(permissionProfileId)
      || !Object.keys(extra).some((key) => ["settings", "setting-sources", "permission-mode", "dangerously-skip-permissions", "allowed-tools"].includes(key)));
    for (const extra of extras) {
      const name = `${permissionProfileId} ${Object.keys(extra).join(",")}`;
      // An option the access level decides itself is the level's, whatever was stored beside it.
      const stored = (on: boolean) => ({ ...extra, ...level(on) });
      assert.deepEqual(attestProviderSpawnPolicy("claude-code", { ...owner, permissionProfileId, homeHarness: true, launchPolicy: stored(true) }), level(true), name);
      // Without the owner's setup the stored policy is passed on exactly as it always was.
      assert.deepEqual(attestProviderSpawnPolicy("claude-code", { ...owner, permissionProfileId, launchPolicy: stored(false) }), stored(false), name);
    }
  }
  const codexLevels: Array<[string, Record<string, unknown>]> = [
    ["full_access", { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }],
    ["ask_before_write", { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } }],
    ["auto_review", { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" }],
    ["read_only", { approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } }],
  ];
  for (const [permissionProfileId, level] of codexLevels) {
    for (const extra of hostile(HOSTILE_CODEX_OPTIONS)) {
      const name = `${permissionProfileId} ${Object.keys(extra).join(",")}`;
      assert.deepEqual(attestProviderSpawnPolicy("codex", { ...owner, permissionProfileId, homeHarness: true, launchPolicy: { ...extra, ...level } }), level, name);
      assert.deepEqual(attestProviderSpawnPolicy("codex", { ...owner, permissionProfileId, launchPolicy: { ...extra, ...level } }), { ...extra, ...level }, name);
    }
  }
  // What is returned is the level's own copy: changing it changes nothing that was stored.
  const stored = { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
  const attested = attestProviderSpawnPolicy("codex", { ...owner, homeHarness: true, launchPolicy: stored });
  (attested.sandboxPolicy as { type: string }).type = "changed";
  assert.equal(stored.sandboxPolicy.type, "dangerFullAccess");
  // The level's own options must still be the stored ones: a policy that contradicts its access level starts nothing.
  assert.throws(() => attestProviderSpawnPolicy("claude-code", { ...owner, homeHarness: true, launchPolicy: { permissionMode: "default", dangerouslySkipPermissions: true } }),
    /does not attest permission-profile authority at 'permissionMode'/);
  // And there must be an access level to build from.
  for (const provider of ["codex", "claude-code"] as const) {
    assert.throws(() => attestProviderSpawnPolicy(provider, { ...owner, permissionProfileId: undefined, homeHarness: true, launchPolicy: {} }),
      /an agent with its owner's own setup starts only under a named access level/, provider);
  }
});

test("the stored options a launch with the owner's own setup left out are named to the owner", () => {
  const level = { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true };
  assert.equal(ownerSetupUnusedOptionsNotice("Claude Code", level, level), null);
  assert.equal(ownerSetupUnusedOptionsNotice("Claude Code", { ...level, settingSources: "user,project,local", pluginDir: "/repo" }, level),
    'With your own setup on, this agent starts with its access level\'s own Claude Code options only. These saved options were not used: "settingSources", "pluginDir".');
  // Names are shown short and printable, and a long list is cut.
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`option${index}`, true]));
  const notice = ownerSetupUnusedOptionsNotice("Codex", { ...many, [`bad\u0007${"x".repeat(100)}`]: 1 }, {})!;
  assert.match(notice, /Codex options only\. These saved options were not used: "option0", .*"option7" and 5 more\.$/);
  assert.equal(notice.includes("\u0007"), false);
  for (const unreadable of [null, undefined, "x", ["x"]]) assert.equal(ownerSetupUnusedOptionsNotice("Codex", unreadable, {}), null);
});

test("the line about left-out options is passed on when it changes for an agent, and again after a start that failed", () => {
  const { whenChanged, forget } = ownerSetupUnusedOptionsSaidOnce;
  assert.equal(whenChanged("agent_a", "left out: x"), "left out: x");
  assert.equal(whenChanged("agent_a", "left out: x"), null, "the same line is not said twice");
  assert.equal(whenChanged("agent_b", "left out: x"), "left out: x", "each agent is told for itself");
  assert.equal(whenChanged("agent_a", "left out: x, y"), "left out: x, y");
  // Nothing left out is a change too, so the same line coming back is said again.
  assert.equal(whenChanged("agent_a", null), null);
  assert.equal(whenChanged("agent_a", "left out: x, y"), "left out: x, y");
  // A start that failed after it was given the line forgets it; one that was given something else does not.
  forget("agent_a", ["another line"]);
  assert.equal(whenChanged("agent_a", "left out: x, y"), null);
  forget("agent_a", ["another line", "left out: x, y"]);
  assert.equal(whenChanged("agent_a", "left out: x, y"), "left out: x, y");
  assert.equal(whenChanged("agent_b", "left out: x"), null, "and only for that agent");
  // An agent with nothing left out has nothing to forget.
  assert.equal(whenChanged("agent_c", null), null);
  forget("agent_c", []);
  assert.equal(whenChanged("agent_c", null), null);
  // An agent that cannot be told apart is always told.
  assert.equal(whenChanged(undefined, "left out: x"), "left out: x");
  assert.equal(whenChanged(undefined, "left out: x"), "left out: x");
  forget(undefined, ["left out: x"]);
});

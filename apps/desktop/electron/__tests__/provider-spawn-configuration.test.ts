import assert from "node:assert/strict";
import test from "node:test";

import { attestProviderSpawnPolicy } from "../main/agents/provider-spawn-configuration.js";

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

  for (const provider of ["open-model", "cursor"] as const) {
    assert.throws(() => attestProviderSpawnPolicy(provider, { ...request, permissionProfileId: "auto_review", launchPolicy: {} }), /Unknown permission profile 'auto_review'/);
  }
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

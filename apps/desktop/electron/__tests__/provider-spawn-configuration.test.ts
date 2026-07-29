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

  assert.deepEqual(attestProviderSpawnPolicy("claude-code", {
    ...request,
    permissionProfileId: "read_only",
    launchPolicy: {
      permissionMode: "plan",
      dangerouslySkipPermissions: false,
    },
  }), {
    permissionMode: "plan",
    dangerouslySkipPermissions: false,
  });

  assert.deepEqual(attestProviderSpawnPolicy("cursor", {
    ...request,
    permissionProfileId: "sandboxed_write",
    launchPolicy: { force: true, sandbox: "enabled" },
  }), {
    force: true,
    sandbox: "enabled",
  });
});

test("managed provider spawn attestation rejects downgraded or unsupported authority", () => {
  assert.throws(() => attestProviderSpawnPolicy("codex", {
    ...request,
    launchPolicy: {
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "dangerFullAccess" },
    },
  }), /approvalPolicy/);

  assert.throws(() => attestProviderSpawnPolicy("claude-code", {
    ...request,
    reasoningEffort: "high",
    permissionProfileId: "read_only",
    launchPolicy: {
      permissionMode: "plan",
      dangerouslySkipPermissions: false,
    },
  }), /does not support.*reasoning effort/);

  assert.throws(() => attestProviderSpawnPolicy("cursor", {
    ...request,
    launchPolicy: { force: false, sandbox: "disabled" },
  }), /permission-profile authority/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Source-text contracts for the supervisor IPC handlers. They read the handler
// source on purpose: each one pins an ordering or a call that a behaviour test
// cannot observe without the real daemon (renderer key projection, permission
// admission before the durable save, recovery that never enters activation).
const ipcSource = readFileSync(
  fileURLToPath(new URL("../main/ipc-handlers/supervisor.ts", import.meta.url)),
  "utf8",
);

function handlerSource(channel: string, nextChannel: string): string {
  const start = ipcSource.indexOf(`"${channel}"`);
  const end = ipcSource.indexOf(`"${nextChannel}"`);
  assert.ok(start >= 0, `${channel} is registered in the supervisor IPC source`);
  assert.ok(end > start, `${nextChannel} is registered after ${channel}`);
  return ipcSource.slice(start, end);
}

test("supervisor list projects canonical agent keys for renderer mention routing", () => {
  const listHandler = ipcSource.slice(
    ipcSource.indexOf('"desktop:supervisor:list-agents"'),
    ipcSource.indexOf('"desktop:supervisor:create-agent"'),
  );
  assert.match(listHandler, /projectDesktopSupervisorAgentKeys\(entries\)/);
  const pushBridge = ipcSource.slice(ipcSource.indexOf('if (!supervisorStateBridgeRegistered)'));
  assert.match(pushBridge, /projectDesktopSupervisorAgentKeys\(snapshot.entries\)/);
});

test("supervisor creation admits supervised profiles before the daemon saves the entry", () => {
  const createHandler = handlerSource("desktop:supervisor:create-agent", "desktop:supervisor:get-launch-events");
  assert.match(createHandler, /provider !== "cursor"/);
  assert.doesNotMatch(createHandler, /provider === "cursor" && input\.permissionProfileId !== "read_only"/);
  assert.match(createHandler, /assertManagedAgentPermissionProfileAvailable\(provider, input\.permissionProfileId, "supervised"\)/);
  const admission = createHandler.indexOf("assertManagedAgentPermissionProfileAvailable");
  const save = createHandler.indexOf("createAndInstall");
  assert.ok(admission >= 0, "the create handler admits the permission profile");
  assert.ok(save >= 0, "the create handler saves through the grant coordinator");
  assert.ok(
    admission < save,
    "permission admission must fail before the daemon saves a durable entry",
  );
});

test("explicit provider recovery prepares authority without entering activation semantics", () => {
  const recoveryHandler = handlerSource("desktop:supervisor:recover-agent-runtime", "desktop:supervisor:control-turn");
  assert.match(recoveryHandler, /prepareEntryForRuntimeRecovery\(entry\)/);
  assert.doesNotMatch(recoveryHandler, /prepareEntryForActivation\(entry\)/);
  assert.doesNotMatch(recoveryHandler, /activateEntry\(/);
  assert.match(recoveryHandler, /input\.recovery\?\.mode === "reconnect"/);
  assert.match(recoveryHandler, /reconnectEntry\(entry\)/);
  assert.match(recoveryHandler, /recoverAgentRuntime\(entry\.id, input\.recovery\)/);
});

test("the supervisor IPC source no longer claims a paused entry or transfers lane ownership", () => {
  assert.doesNotMatch(ipcSource, /transferSupervisorOwnership|createPausedAndInstall|resume-ownership-transfer/);
  assert.doesNotMatch(ipcSource, /supervisor-ownership/);
  assert.doesNotMatch(ipcSource, /compareAndSetDesiredState/);
});

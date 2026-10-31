import assert from "node:assert/strict";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({ prefix: "letagents-provider-setup-confirmation-", paths: [] });

const { providerSetupConfirmationResult } = await import("../main/agents/provider-setup-confirmation.js");

test("agent provider setup confirmation copy covers install actions", () => {
  const managedRuntimeInstall = providerSetupConfirmationResult({
    id: "open-model",
    name: "Open Model",
  }, "install_runtime");
  assert.equal(managedRuntimeInstall.success, false);
  assert.equal(managedRuntimeInstall.action, "install_runtime");
  assert.match(managedRuntimeInstall.message, /requires confirmation/i);
  assert.match(managedRuntimeInstall.detail || "", /managed Open Model execution engine/i);
  assert.match(managedRuntimeInstall.detail || "", /External provider CLIs remain user-managed/i);

  const bridgeInstall = providerSetupConfirmationResult({
    id: "antigravity",
    name: "Antigravity",
  }, "install_mcp_bridge");
  assert.equal(bridgeInstall.success, false);
  assert.equal(bridgeInstall.action, "install_mcp_bridge");
  assert.match(bridgeInstall.message, /requires confirmation/i);
  assert.match(bridgeInstall.detail || "", /agent app configuration/i);
});

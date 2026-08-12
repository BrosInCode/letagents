import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopAgentProvider } from "../ipc-types.js";
import { missingExternalRuntimePreflight } from "../main/agents/external-runtime-preflight.js";

function provider(overrides: Partial<DesktopAgentProvider> = {}): DesktopAgentProvider {
  return {
    id: "codex",
    name: "Codex",
    description: "Codex",
    capabilities: ["desktop_managed_runtime"],
    runtimeCommand: "codex",
    runtimeInstallCommand: "install codex",
    runtimeInstallUrl: "https://example.com/codex",
    mcpTargetId: "codex",
    permissionProfiles: [],
    defaultPermissionProfileId: null,
    ...overrides,
  };
}

test("missing external runtime preflight derives consistent actionable copy from registry metadata", () => {
  const result = missingExternalRuntimePreflight(provider(), "not_installed");
  assert.equal(result.status, "missing_runtime");
  assert.equal(result.nextAction, "install_external_runtime");
  assert.match(result.detail || "", /LetAgents does not install or update external provider CLIs/);
});

test("missing external runtime preflight fails closed when the registry has no install route", () => {
  const result = missingExternalRuntimePreflight(provider({
    runtimeInstallCommand: null,
    runtimeInstallUrl: null,
  }), "installed");
  assert.equal(result.status, "error");
  assert.equal(result.nextAction, null);
  assert.match(result.detail || "", /missing both an install command and an installation guide/i);
});

import assert from "node:assert/strict";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({ prefix: "letagents-provider-registry-", paths: [] });

const { cursorRuntimeInstallCommand, listDesktopAgentProviders } = await import("../main/agents/provider-registry.js");

test("listDesktopAgentProviders excludes antigravity", () => {
  const providers = listDesktopAgentProviders();
  const codex = providers.find((provider) => provider.id === "codex");
  assert.equal(
    codex?.runtimeCommand,
    "codex",
    "Codex launch sites assume the registry uses the canonical command name",
  );
  assert.equal(codex?.capabilities.includes("installable_runtime"), false);
  assert.match(codex?.runtimeInstallCommand || "", /chatgpt\.com\/codex\/install/);
  assert.equal(codex?.runtimeInstallUrl, "https://learn.chatgpt.com/docs/codex/cli");
  assert.equal(
    providers.find((provider) => provider.id === "open-model")
      ?.capabilities.includes("installable_runtime"),
    true,
    "only the LetAgents-managed Open Model engine remains installable",
  );
  assert.ok(
    !providers.some((p) => p.id === "antigravity"),
    "antigravity should not appear in the Add Agent UI provider list",
  );
});

test("external runtime install commands stay valid for the current platform", () => {
  assert.equal(cursorRuntimeInstallCommand("win32"), null);
  assert.match(cursorRuntimeInstallCommand("darwin") || "", /curl .* \| bash/);
  assert.match(cursorRuntimeInstallCommand("linux") || "", /curl .* \| bash/);
});

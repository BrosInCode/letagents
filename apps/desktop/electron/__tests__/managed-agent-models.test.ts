import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempDir = mkdtempSync(join(tmpdir(), "letagents-managed-agent-models-"));

const {
  listDesktopAgentProviderModels,
  normalizeManagedAgentModel,
  parseCodexModelsOutput,
  parseCursorModelsOutput,
  validateDesktopManagedAgentModel,
} = await import("../main/agents/managed-agent-models.js");

test.after(() => {
  delete process.env.LETAGENTS_CODEX_BIN;
  delete process.env.LETAGENTS_CURSOR_AGENT_BIN;
  delete process.env.LETAGENTS_CURSOR_MANAGED_HOME;
  delete process.env.LETAGENTS_CURSOR_SOURCE_HOME;
  delete process.env.LETAGENTS_STATE_PATH;
  rmSync(tempDir, { recursive: true, force: true });
});

test("managed agent model normalization trims blanks to null", () => {
  assert.equal(normalizeManagedAgentModel("  sonnet  "), "sonnet");
  assert.equal(normalizeManagedAgentModel("  "), null);
  assert.equal(normalizeManagedAgentModel(null), null);
});

test("Cursor model parser handles labels, defaults, duplicates, and empty lines", () => {
  const models = parseCursorModelsOutput([
    "Available models:",
    "auto - Auto",
    "composer-2.5-fast - Composer 2.5 Fast (current, default)",
    "default-name - Default Name",
    "bad line without delimiter",
    "gpt-5.2 - GPT-5.2",
    "auto - Duplicate Auto",
    "",
  ].join("\n"));

  assert.deepEqual(models, [
    { id: "auto", label: "Auto", isDefault: false, source: "provider" },
    {
      id: "composer-2.5-fast",
      label: "Composer 2.5 Fast (current, default)",
      isDefault: true,
      source: "provider",
    },
    { id: "default-name", label: "Default Name", isDefault: false, source: "provider" },
    { id: "gpt-5.2", label: "GPT-5.2", isDefault: false, source: "provider" },
  ]);
});

test("Codex model parser handles refreshed catalog JSON", () => {
  const models = parseCodexModelsOutput(JSON.stringify({
    models: [
      {
        slug: "gpt-5.5",
        display_name: "GPT-5.5",
        visibility: "list",
        is_default: true,
        base_instructions: "large prompt omitted",
      },
      {
        slug: "codex-auto-review",
        display_name: "Auto Review",
        visibility: "hidden",
      },
      {
        id: "gpt-5.4-mini",
        displayName: "GPT-5.4 Mini",
        visibility: "list",
      },
      {
        model: "gpt-5.5",
        name: "Duplicate",
        visibility: "list",
      },
    ],
  }));

  assert.deepEqual(models, [
    { id: "gpt-5.5", label: "GPT-5.5", isDefault: true, source: "provider" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", isDefault: false, source: "provider" },
  ]);
});

test("known and custom model validation use the selected source intentionally", async () => {
  assert.deepEqual(await validateDesktopManagedAgentModel({
    providerId: "claude-code",
    model: "sonnet",
    modelSource: "known",
  }), { model: "sonnet", error: null });

  const invalidKnown = await validateDesktopManagedAgentModel({
    providerId: "claude-code",
    model: "unknown-claude-model",
    modelSource: "known",
  });
  assert.equal(invalidKnown.model, "unknown-claude-model");
  assert.match(invalidKnown.error ?? "", /not in the known model list/);

  assert.deepEqual(await validateDesktopManagedAgentModel({
    providerId: "claude-code",
    model: "opusplan",
    modelSource: "known",
  }), { model: "opusplan", error: null });

  assert.deepEqual(await validateDesktopManagedAgentModel({
    providerId: "claude-code",
    model: "sonnet[1m]",
    modelSource: "known",
  }), { model: "sonnet[1m]", error: null });

  assert.deepEqual(await validateDesktopManagedAgentModel({
    providerId: "claude-code",
    model: "unknown-claude-model",
    modelSource: "custom",
  }), { model: "unknown-claude-model", error: null });
});

test("Codex model discovery reads debug model catalog output", async () => {
  const codexBin = join(tempDir, "codex-debug-models");
  writeFileSync(
    codexBin,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] !== 'debug' || process.argv[3] !== 'models') process.exit(2);",
      "console.log(JSON.stringify({ models: [",
      "  { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', is_default: true },",
      "  { slug: 'codex-auto-review', display_name: 'Auto Review', visibility: 'hidden' },",
      "  { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4 Mini', visibility: 'list' }",
      "] }));",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.LETAGENTS_CODEX_BIN = codexBin;

  const result = await listDesktopAgentProviderModels("codex", { refreshModels: true });
  assert.equal(result.status, "ready");
  assert.equal(result.defaultModel, "gpt-5.5");
  assert.deepEqual(result.models.map((model) => model.id), ["gpt-5.5", "gpt-5.4-mini"]);

  assert.deepEqual(await validateDesktopManagedAgentModel({
    providerId: "codex",
    model: "gpt-5.4-mini",
    modelSource: "provider",
  }), { model: "gpt-5.4-mini", error: null });
});

test("Cursor discovered model validation blocks stale provider ids", async () => {
  const cursorBin = join(tempDir, "cursor-agent-models");
  writeFileSync(
    cursorBin,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] !== 'models') process.exit(2);",
      "console.log('auto - Auto');",
      "console.log('gpt-5.2 - GPT-5.2 (default)');",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.LETAGENTS_CURSOR_AGENT_BIN = cursorBin;

  const result = await listDesktopAgentProviderModels("cursor");
  assert.equal(result.status, "ready");
  assert.equal(result.defaultModel, "gpt-5.2");
  assert.deepEqual(result.models.map((model) => model.id), ["auto", "gpt-5.2"]);

  assert.deepEqual(await validateDesktopManagedAgentModel({
    providerId: "cursor",
    model: "gpt-5.2",
    modelSource: "provider",
  }), { model: "gpt-5.2", error: null });

  const stale = await validateDesktopManagedAgentModel({
    providerId: "cursor",
    model: "missing-cursor-model",
    modelSource: "provider",
  });
  assert.equal(stale.model, "missing-cursor-model");
  assert.match(stale.error ?? "", /no longer available/);
});

test("Cursor model discovery uses the managed profile environment", async () => {
  const cursorBin = join(tempDir, "cursor-agent-models-managed-env");
  const managedHome = join(tempDir, "managed-cursor-home");
  writeFileSync(
    cursorBin,
    [
      "#!/usr/bin/env node",
      `if (process.env.HOME !== ${JSON.stringify(managedHome)}) {`,
      "  console.error(`wrong HOME ${process.env.HOME || ''}`);",
      "  process.exit(1);",
      "}",
      "console.log('managed - Managed Profile Model (default)');",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.LETAGENTS_CURSOR_AGENT_BIN = cursorBin;
  process.env.LETAGENTS_CURSOR_MANAGED_HOME = managedHome;
  process.env.LETAGENTS_CURSOR_SOURCE_HOME = join(tempDir, "cursor-source-home");
  process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");

  const result = await listDesktopAgentProviderModels("cursor", {
    repoRootPath: tempDir,
    cursorMcpPolicy: "filter_letagents",
  });

  assert.equal(result.status, "ready");
  assert.equal(result.defaultModel, "managed");
  assert.deepEqual(result.models.map((model) => model.id), ["managed"]);
});

test("Cursor model discovery caches failures briefly and refreshModels bypasses the cache", async () => {
  const cursorBin = join(tempDir, "cursor-agent-models-cache-failure");
  const counterPath = join(tempDir, "cursor-agent-models-cache-count");
  writeFileSync(
    cursorBin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `const counterPath = ${JSON.stringify(counterPath)};`,
      "const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
      "fs.writeFileSync(counterPath, String(count + 1));",
      "console.error('models unavailable');",
      "process.exit(1);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.LETAGENTS_CURSOR_AGENT_BIN = cursorBin;
  delete process.env.LETAGENTS_CURSOR_MANAGED_HOME;
  delete process.env.LETAGENTS_CURSOR_SOURCE_HOME;
  delete process.env.LETAGENTS_STATE_PATH;

  const first = await listDesktopAgentProviderModels("cursor", { repoRootPath: tempDir });
  const second = await listDesktopAgentProviderModels("cursor", { repoRootPath: tempDir });
  const refreshed = await listDesktopAgentProviderModels("cursor", {
    repoRootPath: tempDir,
    refreshModels: true,
  });

  assert.equal(first.status, "error");
  assert.equal(second.status, "error");
  assert.equal(refreshed.status, "error");
  assert.equal(existsSync(counterPath), true);
  assert.equal(readFileSync(counterPath, "utf8"), "2");
});

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";
import { supervisedAgentsOnly } from "./platform.js";

const { tempDir } = createElectronTestEnv({
  prefix: "letagents-managed-agent-models-",
  paths: [],
  extraCleanupEnvKeys: [
    "LETAGENTS_CLAUDE_CODE_BIN",
    "LETAGENTS_CODEX_BIN",
    "LETAGENTS_CURSOR_AGENT_BIN",
    "LETAGENTS_CURSOR_MANAGED_HOME",
    "LETAGENTS_CURSOR_SOURCE_HOME",
    "LETAGENTS_STATE_PATH",
  ],
});

const {
  listDesktopAgentProviderModels,
  normalizeManagedAgentEffort,
  normalizeManagedAgentModel,
  parseCodexModelsOutput,
  parseCursorModelsOutput,
  validateDesktopManagedAgentModel,
} = await import("../main/agents/managed-agent-models.js");

test("managed agent model normalization trims blanks to null", () => {
  assert.equal(normalizeManagedAgentModel("  sonnet  "), "sonnet");
  assert.equal(normalizeManagedAgentModel("  "), null);
  assert.equal(normalizeManagedAgentModel(null), null);
});

test("managed agent effort normalization trims and rejects unknown values", () => {
  assert.equal(normalizeManagedAgentEffort("  high  "), "high");
  assert.equal(normalizeManagedAgentEffort("unsupported"), null);
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

test("Cursor model parser accepts bullet and plain model listings", () => {
  const models = parseCursorModelsOutput([
    "\u001b[1mAvailable models\u001b[0m",
    "- auto",
    "  composer-2.5 - Composer 2.5",
    "gpt-5.2 (default)",
  ].join("\n"));

  assert.deepEqual(models, [
    { id: "auto", label: "auto", isDefault: false, source: "provider" },
    { id: "composer-2.5", label: "Composer 2.5", isDefault: false, source: "provider" },
    { id: "gpt-5.2", label: "gpt-5.2 (default)", isDefault: true, source: "provider" },
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

function fakeClaude(version: string): void {
  const claudeBin = join(tempDir, `claude-${version}`);
  writeFileSync(claudeBin, [
    "#!/usr/bin/env node",
    "if (process.argv[2] !== '--version') process.exit(2);",
    `console.log('${version} (Claude Code)');`,
    "",
  ].join("\n"), { mode: 0o755 });
  process.env.LETAGENTS_CLAUDE_CODE_BIN = claudeBin;
}

test("Claude models are full ids with real names, and newer ones only from the CLI that knows them", { skip: supervisedAgentsOnly }, async () => {
  fakeClaude("2.1.278");
  const older = await listDesktopAgentProviderModels("claude-code", { refreshModels: true });
  assert.equal(older.status, "ready");
  assert.deepEqual(older.models.map((model) => [model.id, model.label]), [
    ["best", "Best available"],
    ["claude-fable-5-1", "Fable 5.1"],
    ["claude-fable-5", "Fable 5"],
    ["claude-opus-5", "Opus 5"],
    ["claude-sonnet-5", "Sonnet 5"],
    ["claude-haiku-4-5", "Haiku 4.5"],
    ["claude-opus-5[1m]", "Opus 5 1M"],
    ["claude-sonnet-5[1m]", "Sonnet 5 1M"],
  ]);
  assert.ok(older.models.every((model) => !("minimumCliVersion" in model)));

  fakeClaude("2.1.280");
  const cached = await listDesktopAgentProviderModels("claude-code");
  assert.equal(cached.models.some((model) => model.id === "claude-opus-5-5"), true, "a different CLI path is its own cache entry");
  const newer = await listDesktopAgentProviderModels("claude-code", { refreshModels: true });
  assert.deepEqual(newer.models.filter((model) => model.id.endsWith("-5-5")).map((model) => model.label), ["Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);

  process.env.LETAGENTS_CLAUDE_CODE_BIN = join(tempDir, "no-such-claude");
  const missing = await listDesktopAgentProviderModels("claude-code", { refreshModels: true });
  assert.equal(missing.status, "ready", "an unreadable version still lists the models every CLI takes");
  assert.equal(missing.models.some((model) => model.id === "claude-sonnet-5-5"), false);
  delete process.env.LETAGENTS_CLAUDE_CODE_BIN;
});

test("known and custom model validation use the selected source intentionally", { skip: supervisedAgentsOnly }, async () => {
  fakeClaude("2.1.278");
  assert.deepEqual(await validateDesktopManagedAgentModel({
    providerId: "claude-code",
    model: "claude-sonnet-5",
    modelSource: "known",
  }), { model: "claude-sonnet-5", error: null });

  assert.deepEqual(await validateDesktopManagedAgentModel({
    providerId: "claude-code",
    model: "claude-opus-5[1m]",
    modelSource: "known",
  }), { model: "claude-opus-5[1m]", error: null });

  const invalidKnown = await validateDesktopManagedAgentModel({
    providerId: "claude-code",
    model: "unknown-claude-model",
    modelSource: "known",
  });
  assert.equal(invalidKnown.model, "unknown-claude-model");
  assert.match(invalidKnown.error ?? "", /not in the known model list/);

  // An alias is no longer listed; a new agent may still name one as a custom id.
  assert.match((await validateDesktopManagedAgentModel({
    providerId: "claude-code",
    model: "opusplan",
    modelSource: "known",
  })).error ?? "", /not in the known model list/);

  assert.deepEqual(await validateDesktopManagedAgentModel({
    providerId: "claude-code",
    model: "unknown-claude-model",
    modelSource: "custom",
  }), { model: "unknown-claude-model", error: null });
  delete process.env.LETAGENTS_CLAUDE_CODE_BIN;
});

test("Codex model discovery reads debug model catalog output", { skip: supervisedAgentsOnly }, async () => {
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

test("Codex stale ready model cache is extended after failed rediscovery", { skip: supervisedAgentsOnly }, async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);

  const codexBin = join(tempDir, "codex-debug-models-stale-cache");
  const counterPath = join(tempDir, "codex-debug-models-stale-cache-count");
  const failPath = join(tempDir, "codex-debug-models-stale-cache-fail");
  writeFileSync(
    codexBin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `const counterPath = ${JSON.stringify(counterPath)};`,
      `const failPath = ${JSON.stringify(failPath)};`,
      "const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
      "fs.writeFileSync(counterPath, String(count + 1));",
      "if (fs.existsSync(failPath)) {",
      "  console.error('codex unavailable');",
      "  process.exit(1);",
      "}",
      "if (process.argv[2] !== 'debug' || process.argv[3] !== 'models') process.exit(2);",
      "console.log(JSON.stringify({ models: [",
      "  { slug: 'gpt-cache', display_name: 'GPT Cache', visibility: 'list' }",
      "] }));",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.LETAGENTS_CODEX_BIN = codexBin;

  const first = await listDesktopAgentProviderModels("codex", { refreshModels: true });
  assert.equal(first.status, "ready");
  assert.deepEqual(first.models.map((model) => model.id), ["gpt-cache"]);

  writeFileSync(failPath, "fail");
  now += 61_000;
  const stale = await listDesktopAgentProviderModels("codex");
  const cachedAgain = await listDesktopAgentProviderModels("codex");

  assert.equal(stale.status, "ready");
  assert.equal(cachedAgain.status, "ready");
  assert.deepEqual(cachedAgain.models.map((model) => model.id), ["gpt-cache"]);
  assert.equal(readFileSync(counterPath, "utf8"), "3");
});

test("Cursor discovered model validation blocks stale provider ids", { skip: supervisedAgentsOnly }, async () => {
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

test("Cursor model discovery uses the managed profile environment", { skip: supervisedAgentsOnly }, async () => {
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
  });

  assert.equal(result.status, "ready");
  assert.equal(result.defaultModel, "managed");
  assert.deepEqual(result.models.map((model) => model.id), ["managed"]);
});

test("Cursor model discovery caches failures briefly and refreshModels bypasses the cache", { skip: supervisedAgentsOnly }, async () => {
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

test("a fresh Cursor model list is returned before the managed profile is prepared", { skip: supervisedAgentsOnly }, async () => {
  const cursorBin = join(tempDir, "cursor-agent-models-profile-skip");
  const managedHome = join(tempDir, "profile-skip", "home");
  writeFileSync(cursorBin, "#!/usr/bin/env node\nconsole.log('fast - Fast Model (default)');\n", { mode: 0o755 });
  process.env.LETAGENTS_CURSOR_AGENT_BIN = cursorBin;
  process.env.LETAGENTS_CURSOR_MANAGED_HOME = managedHome;
  process.env.LETAGENTS_CURSOR_SOURCE_HOME = join(tempDir, "cursor-source-home");
  process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");
  const repoRootPath = join(tempDir, "profile-skip-repo");
  mkdirSync(repoRootPath, { recursive: true });

  assert.equal((await listDesktopAgentProviderModels("cursor", { repoRootPath })).status, "ready");
  assert.equal(existsSync(managedHome), true, "a miss prepares the managed profile");
  rmSync(join(tempDir, "profile-skip"), { recursive: true, force: true });
  // Before: every call prepared the profile (about 30 sync fs calls) first.
  assert.equal((await listDesktopAgentProviderModels("cursor", { repoRootPath })).status, "ready");
  assert.equal(existsSync(managedHome), false, "a hit never touches the profile");
  process.env.LETAGENTS_CURSOR_MANAGED_HOME = join(tempDir, "profile-skip", "other-home");
  await listDesktopAgentProviderModels("cursor", { repoRootPath });
  assert.equal(existsSync(join(tempDir, "profile-skip", "other-home")), true, "a different profile location is a different key");
  process.env.LETAGENTS_CURSOR_MANAGED_HOME = managedHome;
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = join(tempDir, "profile-skip-other-user");
    mkdirSync(process.env.HOME, { recursive: true });
    rmSync(managedHome, { recursive: true, force: true });
    await listDesktopAgentProviderModels("cursor", { repoRootPath });
    assert.equal(existsSync(managedHome), true, "a different HOME is a different key");
  } finally {
    process.env.HOME = previousHome;
  }
  await listDesktopAgentProviderModels("cursor", { repoRootPath, refreshModels: true });
  assert.equal(existsSync(managedHome), true, "refreshModels prepares the profile again");
});

test("the model list cache drops long-expired entries and stays bounded", async (t) => {
  const cursorBin = join(tempDir, "cursor-agent-models-prune");
  writeFileSync(cursorBin, "#!/usr/bin/env node\nconsole.log('one - One (default)');\n", { mode: 0o755 });
  process.env.LETAGENTS_CURSOR_AGENT_BIN = cursorBin;
  delete process.env.LETAGENTS_CURSOR_MANAGED_HOME;
  process.env.LETAGENTS_CURSOR_SOURCE_HOME = join(tempDir, "cursor-source-home");
  process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");
  const { modelListCacheSizeForTest } = await import("../main/agents/managed-agent-models.js");
  let now = Date.now() + 60 * 60_000;
  t.mock.method(Date, "now", () => now);
  const roots = Array.from({ length: 70 }, (_, index) => join(tempDir, `prune-${index}`));
  for (const root of roots) mkdirSync(root, { recursive: true });
  for (const root of roots) await listDesktopAgentProviderModels("cursor", { repoRootPath: root });
  assert.equal(modelListCacheSizeForTest(), 64, "the cache never holds more than 64 lists");
  now += 12 * 60_000;
  await listDesktopAgentProviderModels("cursor", { repoRootPath: roots[0] });
  assert.equal(modelListCacheSizeForTest(), 1, "a write drops lists expired past the stale-retention window");
});

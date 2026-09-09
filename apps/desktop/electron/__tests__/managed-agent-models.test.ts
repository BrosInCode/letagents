import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

const { tempDir } = createElectronTestEnv({
  prefix: "letagents-managed-agent-models-",
  paths: [],
  extraCleanupEnvKeys: [
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
  normalizeManagedAgentEffortForProvider,
  normalizeManagedAgentModel,
  parseCodexModelsOutput,
  parseCursorModelsOutput,
  validateDesktopManagedAgentModel,
} = await import("../main/agents/managed-agent-models.js");
const { validateCodexDefaultModel } = await import("../main/agents/codex-default-model.js");

function codexDefaultFixture(name: string, config: unknown, pages: unknown[], mode = "ready") {
  const command = join(tempDir, `codex-default-${name}`);
  const log = `${command}.log`;
  writeFileSync(command, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    `const log = ${JSON.stringify(log)}, config = ${JSON.stringify(config)}, pages = ${JSON.stringify(pages)}, mode = ${JSON.stringify(mode)};`,
    "if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['app-server','--listen','stdio://'])) process.exit(2);",
    "let initialized = false, page = 0;",
    "fs.appendFileSync(log, JSON.stringify({cwd:process.cwd(),home:process.env.CODEX_HOME,pid:process.pid})+'\\n');",
    "require('node:readline').createInterface({input:process.stdin}).on('line', line => {",
    "  const request = JSON.parse(line); fs.appendFileSync(log,line+'\\n');",
    "  if (mode === 'hang') return;",
    "  if (request.method === 'initialized') { initialized = true; return; }",
    "  let result;",
    "  if (request.method === 'initialize') result = {};",
    "  else if (!initialized) process.exit(3);",
    "  else if (request.method === 'config/read') {",
    "    if (mode === 'config-error') { console.log(JSON.stringify({id:request.id,error:{message:'config migration required'}})); return; }",
    "    result = {config};",
    "  } else if (request.method === 'model/list') result = pages[page++];",
    "  else process.exit(4);",
    "  console.log(JSON.stringify({id:request.id,result}));",
    "});",
  ].join("\n"), { mode: 0o755 });
  return { command, log };
}

test("blank Codex selection validates the inherited model through the selected CLI and repository", async () => {
  const fixture = codexDefaultFixture("unsupported", {model: "gpt-6-astra", model_provider: null}, [
    { data: [{model:"gpt-5.6-sol",isDefault:true}], nextCursor:null },
  ]);
  process.env.LETAGENTS_CODEX_BIN = fixture.command;
  const result = await validateDesktopManagedAgentModel({ providerId:"codex", model:" ", repoRootPath:tempDir });
  assert.equal(result.model, null, "validation does not persist a default override");
  assert.match(result.error!, /gpt-6-astra.*not available/);
  assert.ok(result.error!.includes(fixture.command));
  assert.match(result.error!, /Update.*select a supported model/);
  const log = readFileSync(fixture.log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(log[0].cwd, realpathSync(tempDir));
  assert.deepEqual(log.slice(1).map(row => row.method), ["initialize","initialized","config/read","model/list"]);
  assert.deepEqual(log[3].params, {includeLayers:false,cwd:tempDir});
  assert.equal(log[4].params.includeHidden, true);
  assert.throws(() => process.kill(log[0].pid, 0), "preflight process exits before validation resolves");
});

test("Codex inherited validation accepts hidden paginated models and CLI defaults without changing explicit custom semantics", async () => {
  const fixture = codexDefaultFixture("supported", {model:"internal-model"}, [
    {data:[{model:"other",isDefault:true}],nextCursor:"page-2"},
    {data:[{model:"internal-model",hidden:true}],nextCursor:null},
  ]);
  assert.equal(await validateCodexDefaultModel({command:fixture.command,env:{...process.env,CODEX_HOME:tempDir},cwd:tempDir}), null);
  const log = readFileSync(fixture.log,"utf8").trim().split("\n").map(line=>JSON.parse(line));
  assert.equal(log[0].home,tempDir);
  assert.equal(log.at(-1).params.cursor,"page-2");
  const noOverride = codexDefaultFixture("no-override", {model:null}, [{data:[{model:"default-model",isDefault:true}]}]);
  assert.equal(await validateCodexDefaultModel({command:noOverride.command,env:process.env}),null);
  process.env.LETAGENTS_CODEX_BIN = join(tempDir,"missing-codex");
  assert.deepEqual(await validateDesktopManagedAgentModel({providerId:"codex",model:"custom-model",modelSource:"custom"}),{model:"custom-model",error:null});
  assert.deepEqual(await validateDesktopManagedAgentModel({providerId:"claude-code",model:null}),{model:null,error:null});
});

test("Codex custom-provider defaults bypass the OpenAI namespace; unknown catalogs and failed config reads cannot claim compatibility", async () => {
  const custom = codexDefaultFixture("custom-provider", {model:"local-model",model_provider:"local"}, []);
  assert.equal(await validateCodexDefaultModel({command:custom.command,env:process.env}),null);
  assert.ok(!readFileSync(custom.log,"utf8").includes('"model/list"'));
  for (const mode of ["ready","config-error"]) {
    const fixture = codexDefaultFixture(`unknown-${mode}`, {model:"model"}, [{data:[]}],mode);
    const error = await validateCodexDefaultModel({command:fixture.command,env:process.env});
    assert.match(error!,/Could not verify/);
    assert.doesNotMatch(error!,/not available/);
  }
  const hanging = codexDefaultFixture("timeout", {}, [], "hang");
  assert.match((await validateCodexDefaultModel({command:hanging.command,env:process.env,timeoutMs:1500}))!,/Could not verify/);
  const first = JSON.parse(readFileSync(hanging.log,"utf8").split("\n")[0]!);
  assert.throws(() => process.kill(first.pid,0));
});

test("managed agent model normalization trims blanks to null", () => {
  assert.equal(normalizeManagedAgentModel("  sonnet  "), "sonnet");
  assert.equal(normalizeManagedAgentModel("  "), null);
  assert.equal(normalizeManagedAgentModel(null), null);
});

test("managed agent effort normalization is provider aware", () => {
  assert.equal(normalizeManagedAgentEffort("  high  "), "high");
  assert.equal(normalizeManagedAgentEffort("unsupported"), null);
  assert.equal(normalizeManagedAgentEffortForProvider("codex", "xhigh"), "xhigh");
  assert.equal(normalizeManagedAgentEffortForProvider("codex", "max"), null);
  assert.equal(normalizeManagedAgentEffortForProvider("claude-code", "max"), "max");
  assert.equal(normalizeManagedAgentEffortForProvider("cursor", "high"), null);
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

test("known and custom model validation use the selected source intentionally", async () => {
  const claudeModels = await listDesktopAgentProviderModels("claude-code");
  assert.deepEqual(claudeModels.models.slice(0, 4).map((model) => model.label), [
    "Fable 5",
    "Opus (latest)",
    "Sonnet (latest)",
    "Haiku (latest)",
  ]);

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

test("Codex stale ready model cache is extended after failed rediscovery", async (t) => {
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

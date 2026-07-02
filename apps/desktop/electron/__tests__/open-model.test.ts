import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Buffer } from "node:buffer";

import { codexAppServerLaunchArgs } from "../main/agents/codex-app-server.js";
import {
  assertManagedAgentPermissionProfileAvailable,
  defaultManagedAgentPermissionProfileId,
  listManagedAgentPermissionProfiles,
} from "../main/agents/managed-agent-permission-profiles.js";
import {
  OPEN_MODEL_API_KEY_ENV,
  openModelCodexLaunch,
} from "../main/agents/open-model-launch.js";
import {
  DEFAULT_OPEN_MODEL_BASE_URL,
  getOpenModelSettingsStatus,
  readOpenModelSettings,
  saveOpenModelSettings,
} from "../main/agents/open-model-settings.js";

const secretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
  decryptString: (value: Buffer) =>
    value.toString("utf8").replace(/^encrypted:/, ""),
};

async function tempSettingsPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "letagents-open-model-"));
  return join(dir, "settings.json");
}

test("open model settings encrypt the API key and round-trip", async () => {
  const settingsPath = await tempSettingsPath();

  await saveOpenModelSettings(
    {
      baseUrl: "https://openrouter.ai/api/v1/",
      model: "qwen/qwen3-coder",
      apiKey: "open-model-secret",
    },
    { storePath: settingsPath, secretStorage },
  );

  const raw = await readFile(settingsPath, "utf8");
  assert.doesNotMatch(raw, /open-model-secret/);

  const settings = await readOpenModelSettings({ storePath: settingsPath, secretStorage });
  assert.equal(settings.apiKey, "open-model-secret");
  assert.equal(settings.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(settings.model, "qwen/qwen3-coder");

  const status = await getOpenModelSettingsStatus({ storePath: settingsPath, secretStorage });
  assert.equal(status.configured, true);
  assert.equal(status.hasApiKey, true);
  assert.equal(status.model, "qwen/qwen3-coder");
});

test("open model settings keep the saved key when apiKey is undefined and clear it on null", async () => {
  const settingsPath = await tempSettingsPath();
  await saveOpenModelSettings(
    { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3", apiKey: "keep-me" },
    { storePath: settingsPath, secretStorage },
  );

  const kept = await saveOpenModelSettings(
    { model: "qwen3-coder" },
    { storePath: settingsPath, secretStorage },
  );
  assert.equal(kept.hasApiKey, true);
  assert.equal(kept.model, "qwen3-coder");
  assert.equal(kept.baseUrl, "http://127.0.0.1:11434/v1");

  const cleared = await saveOpenModelSettings(
    { apiKey: null },
    { storePath: settingsPath, secretStorage },
  );
  assert.equal(cleared.hasApiKey, false);
  assert.equal(cleared.configured, true);
});

test("open model settings reject saving a key without encryption", async () => {
  const settingsPath = await tempSettingsPath();
  await assert.rejects(
    saveOpenModelSettings(
      { baseUrl: DEFAULT_OPEN_MODEL_BASE_URL, model: "m", apiKey: "secret" },
      {
        storePath: settingsPath,
        secretStorage: { ...secretStorage, isEncryptionAvailable: () => false },
      },
    ),
    /Secure credential storage is unavailable/,
  );
});

test("open model settings reject invalid endpoint URLs", async () => {
  const settingsPath = await tempSettingsPath();
  await assert.rejects(
    saveOpenModelSettings(
      { baseUrl: "not-a-url", model: "m" },
      { storePath: settingsPath, secretStorage },
    ),
    /not a valid URL/,
  );
});

test("unconfigured open model settings report configured=false", async () => {
  const settingsPath = await tempSettingsPath();
  const status = await getOpenModelSettingsStatus({ storePath: settingsPath, secretStorage });
  assert.equal(status.configured, false);
  assert.equal(status.hasApiKey, false);
  assert.equal(status.baseUrl, DEFAULT_OPEN_MODEL_BASE_URL);
});

test("openModelCodexLaunch builds provider overrides and passes the key via env only", () => {
  const launch = openModelCodexLaunch({
    apiKey: "sk-or-secret",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen3-coder",
    savedAt: null,
  });

  assert.deepEqual(launch.env, { [OPEN_MODEL_API_KEY_ENV]: "sk-or-secret" });
  assert.ok(launch.configOverrides.includes('model="qwen/qwen3-coder"'));
  assert.ok(launch.configOverrides.includes('model_provider="letagents_open_model"'));
  assert.ok(
    launch.configOverrides.includes(
      'model_providers.letagents_open_model.base_url="https://openrouter.ai/api/v1"',
    ),
  );
  assert.ok(
    launch.configOverrides.includes('model_providers.letagents_open_model.wire_api="chat"'),
  );
  assert.ok(
    launch.configOverrides.includes(
      `model_providers.letagents_open_model.env_key="${OPEN_MODEL_API_KEY_ENV}"`,
    ),
  );
  assert.ok(
    launch.configOverrides.includes(
      `shell_environment_policy.exclude=["${OPEN_MODEL_API_KEY_ENV}"]`,
    ),
    "the API key env var must be excluded from model-run shell commands",
  );
  for (const override of launch.configOverrides) {
    assert.doesNotMatch(override, /sk-or-secret/);
  }
});

test("openModelCodexLaunch omits env_key for keyless local endpoints", () => {
  const launch = openModelCodexLaunch({
    apiKey: null,
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3-coder",
    savedAt: null,
  });

  assert.deepEqual(launch.env, {});
  assert.ok(!launch.configOverrides.some((override) => override.includes("env_key")));
  assert.ok(
    launch.configOverrides.includes(
      `shell_environment_policy.exclude=["${OPEN_MODEL_API_KEY_ENV}"]`,
    ),
    "shell exclusion stays on even without a saved key, in case the var is exported in the desktop env",
  );
});

test("openModelCodexLaunch refuses unconfigured settings", () => {
  assert.throws(
    () =>
      openModelCodexLaunch({
        apiKey: null,
        baseUrl: DEFAULT_OPEN_MODEL_BASE_URL,
        model: "",
        savedAt: null,
      }),
    /Configure a model endpoint/,
  );
});

test("open-model permission profiles default to honestly-labeled full access", () => {
  const profiles = listManagedAgentPermissionProfiles("open-model");
  assert.ok(profiles.length >= 1);
  assert.equal(defaultManagedAgentPermissionProfileId("open-model"), "full_access");
  const fullAccess = assertManagedAgentPermissionProfileAvailable("open-model", "full_access");
  assert.equal(fullAccess.risk, "high");
  assert.throws(
    () => assertManagedAgentPermissionProfileAvailable("open-model", "read_only"),
    /not available/,
  );
});

test("codexAppServerLaunchArgs threads config overrides after the trust override", () => {
  const args = codexAppServerLaunchArgs("ws://127.0.0.1:4500", {
    trustedProjectPath: "/repo",
    configOverrides: ['model="qwen/qwen3-coder"'],
  });

  assert.deepEqual(args, [
    "app-server",
    "-c",
    'projects."/repo".trust_level="trusted"',
    "-c",
    'model="qwen/qwen3-coder"',
    "--listen",
    "ws://127.0.0.1:4500",
  ]);
});

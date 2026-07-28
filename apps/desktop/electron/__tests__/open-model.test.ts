import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { runDesktopAgentProviderPreflight } from "../main/agents/providers.js";
import {
  listDesktopAgentProviders,
  supervisedDeliveryModeForProvider,
} from "../main/agents/provider-registry.js";

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

const unsafeOpenModelBaseUrls = [
  "https://alice:unsafe-secret@example.com/v1",
  "https://example.com/v1?api_key=unsafe-secret",
  "https://example.com/v1?access-token=unsafe-secret",
  "https://example.com/v1?auth[client_secret]=unsafe-secret",
  "https://example.com/v1?X-Amz-Signature=unsafe-secret",
  "https://example.com/v1?refresh_token=unsafe-secret",
  "https://example.com/v1?session_token=unsafe-secret",
  "https://example.com/v1?private_key=unsafe-secret",
  "https://example.com/v1?api_secret=unsafe-secret",
  "https://example.com/v1?access_key_id=unsafe-secret",
  "https://example.com/v1?AWSAccessKeyId=unsafe-secret",
  "https://example.com/v1?apikey=unsafe-secret",
  "https://example.com/v1?authtoken=unsafe-secret",
  "https://example.com/v1?clientsecret=unsafe-secret",
  "https://example.com/v1?securitytoken=unsafe-secret",
  "https://example.com/v1?secretkey=unsafe-secret",
  "https://example.com/v1?accesskeyid=unsafe-secret",
  "https://example.com/v1?awsaccesskeyid=unsafe-secret",
  "https://example.com/v1#access_token=unsafe-secret",
];

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

  const malformedSecretUrl = "https://[invalid.example/?api_key=malformed-secret";
  await assert.rejects(
    saveOpenModelSettings(
      { baseUrl: malformedSecretUrl, model: "m" },
      { storePath: settingsPath, secretStorage },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /not a valid URL/);
      assert.doesNotMatch(error.message, /api_key|malformed-secret/);
      return true;
    },
  );
});

test("open model settings reject endpoint URLs that expose secrets without echoing them", async () => {
  for (const baseUrl of unsafeOpenModelBaseUrls) {
    const settingsPath = await tempSettingsPath();
    await assert.rejects(
      saveOpenModelSettings(
        { baseUrl, model: "m" },
        { storePath: settingsPath, secretStorage },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /must not contain/);
        assert.doesNotMatch(error.message, /alice|unsafe-secret/);
        assert.equal(error.message.includes(baseUrl), false);
        return true;
      },
    );
  }
});

test("open model settings preserve ordinary non-secret endpoint query options", async () => {
  const settingsPath = await tempSettingsPath();
  const baseUrl =
    "https://models.example.test/v1?region=us-east-1&compat=responses&design=minimal&author=alice&monkey=capuchin";

  const status = await saveOpenModelSettings(
    { baseUrl, model: "m" },
    { storePath: settingsPath, secretStorage },
  );

  assert.equal(status.baseUrl, baseUrl);
  assert.equal((await readOpenModelSettings({ storePath: settingsPath, secretStorage })).baseUrl, baseUrl);
});

test("unconfigured open model settings report configured=false", async () => {
  const settingsPath = await tempSettingsPath();
  const status = await getOpenModelSettingsStatus({ storePath: settingsPath, secretStorage });
  assert.equal(status.configured, false);
  assert.equal(status.hasApiKey, false);
  assert.equal(status.baseUrl, DEFAULT_OPEN_MODEL_BASE_URL);
});

test("Open Model preflight accepts a per-agent model when no saved default exists", async () => {
  const settingsPath = await tempSettingsPath();
  const bin = join(tmpdir(), `letagents-codex-open-model-${Date.now()}`);
  const previousSettingsPath = process.env.LETAGENTS_OPEN_MODEL_SETTINGS_PATH;
  const previousCodexBin = process.env.LETAGENTS_CODEX_BIN;
  await saveOpenModelSettings(
    { baseUrl: "http://127.0.0.1:11434/v1", model: null },
    { storePath: settingsPath, secretStorage },
  );
  await writeFile(
    bin,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === '--version') { console.log('codex test'); process.exit(0); }",
      "if (process.argv[2] === 'app-server' && process.argv[3] === '--help') { console.log('help'); process.exit(0); }",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.LETAGENTS_OPEN_MODEL_SETTINGS_PATH = settingsPath;
  process.env.LETAGENTS_CODEX_BIN = bin;
  try {
    // The electron suite runs test files as parallel node processes, so
    // spawning the fake codex child can take arbitrarily long under load.
    // Disable the per-command wall-clock timeout: the fake binary always exits
    // on its own, and the timeout itself is not the behavior under test.
    const result = await runDesktopAgentProviderPreflight(
      "open-model",
      {
        repoRootPath: tmpdir(),
        model: "qwen/custom-session-model",
        modelSource: "custom",
      },
      { commandTimeoutMs: 0 },
    );
    assert.equal(result.canStart, true);
    assert.match(result.detail ?? "", /qwen\/custom-session-model/);
    assert.match(result.version ?? "", /qwen\/custom-session-model/);
  } finally {
    if (previousSettingsPath === undefined) {
      delete process.env.LETAGENTS_OPEN_MODEL_SETTINGS_PATH;
    } else {
      process.env.LETAGENTS_OPEN_MODEL_SETTINGS_PATH = previousSettingsPath;
    }
    if (previousCodexBin === undefined) {
      delete process.env.LETAGENTS_CODEX_BIN;
    } else {
      process.env.LETAGENTS_CODEX_BIN = previousCodexBin;
    }
  }
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
    launch.configOverrides.includes('model_providers.letagents_open_model.wire_api="responses"'),
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

test("openModelCodexLaunch rejects unsafe endpoint settings loaded from disk", () => {
  for (const baseUrl of unsafeOpenModelBaseUrls) {
    assert.throws(
      () =>
        openModelCodexLaunch({
          apiKey: null,
          baseUrl,
          model: "m",
          savedAt: null,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /must not contain/);
        assert.doesNotMatch(error.message, /alice|unsafe-secret/);
        assert.equal(error.message.includes(baseUrl), false);
        return true;
      },
    );
  }
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

test("Open Model remains capability-gated from durable supervision", () => {
  const providers = listDesktopAgentProviders();
  const codex = providers.find((provider) => provider.id === "codex");
  const claude = providers.find((provider) => provider.id === "claude-code");
  const openModel = providers.find((provider) => provider.id === "open-model");

  assert.ok(codex?.capabilities.includes("supervised_runtime"));
  assert.ok(claude?.capabilities.includes("supervised_runtime"));
  assert.ok(openModel?.capabilities.includes("desktop_managed_runtime"));
  assert.equal(openModel?.capabilities.includes("supervised_runtime"), false);
});

test("supervised provider admission declares room delivery without provider-name checks", () => {
  assert.equal(supervisedDeliveryModeForProvider("codex"), "daemon_inbox");
  assert.equal(supervisedDeliveryModeForProvider("claude-code"), "mcp_polling");
  assert.throws(() => supervisedDeliveryModeForProvider("cursor"), /not available through the supervised engine/);
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

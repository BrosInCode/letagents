import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertManagedAgentPermissionProfileAvailable,
  defaultManagedAgentPermissionProfileId,
  listManagedAgentPermissionProfiles,
} from "../main/agents/managed-agent-permission-profiles.js";
import { openCodeConfig } from "../main/agents/opencode-launch-contract.js";
import {
  OPENCODE_RUNTIME_VERSION,
  openCodeInstallCommand,
  resolveOpenCodeBinary,
} from "../main/agents/opencode-runtime.js";
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
    "https://models.example.test/v1?region=us-east-1&compat=chat&design=minimal&author=alice&monkey=capuchin";

  const status = await saveOpenModelSettings(
    { baseUrl, model: "m" },
    { storePath: settingsPath, secretStorage },
  );

  assert.equal(status.baseUrl, baseUrl);
  assert.equal(
    (await readOpenModelSettings({ storePath: settingsPath, secretStorage })).baseUrl,
    baseUrl,
  );
});

test("unconfigured open model settings report configured=false", async () => {
  const settingsPath = await tempSettingsPath();
  const status = await getOpenModelSettingsStatus({ storePath: settingsPath, secretStorage });
  assert.equal(status.configured, false);
  assert.equal(status.hasApiKey, false);
  assert.equal(status.baseUrl, DEFAULT_OPEN_MODEL_BASE_URL);
});

test("Open Model preflight checks OpenCode and accepts a per-agent model", async () => {
  const settingsPath = await tempSettingsPath();
  const bin = join(tmpdir(), `letagents-opencode-${Date.now()}`);
  const previousSettingsPath = process.env.LETAGENTS_OPEN_MODEL_SETTINGS_PATH;
  const previousOpenCodeBin = process.env.LETAGENTS_OPENCODE_BIN;
  await saveOpenModelSettings(
    { baseUrl: "http://127.0.0.1:11434/v1", model: null },
    { storePath: settingsPath, secretStorage },
  );
  await writeFile(
    bin,
    [
      "#!/usr/bin/env node",
      `if (process.argv[2] === '--version') { console.log('opencode ${OPENCODE_RUNTIME_VERSION}'); process.exit(0); }`,
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.LETAGENTS_OPEN_MODEL_SETTINGS_PATH = settingsPath;
  process.env.LETAGENTS_OPENCODE_BIN = bin;
  try {
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
    assert.match(result.version ?? "", new RegExp(OPENCODE_RUNTIME_VERSION.replaceAll(".", "\\.")));
    assert.match(result.detail ?? "", /No OpenCode account is required/i);
  } finally {
    if (previousSettingsPath === undefined) {
      delete process.env.LETAGENTS_OPEN_MODEL_SETTINGS_PATH;
    } else {
      process.env.LETAGENTS_OPEN_MODEL_SETTINGS_PATH = previousSettingsPath;
    }
    if (previousOpenCodeBin === undefined) {
      delete process.env.LETAGENTS_OPENCODE_BIN;
    } else {
      process.env.LETAGENTS_OPENCODE_BIN = previousOpenCodeBin;
    }
  }
});

test("OpenCode config exposes product tools without embedding the provider key", () => {
  const config = openCodeConfig({
    model: "qwen/qwen3-coder",
    baseUrl: "https://openrouter.ai/api/v1",
    pluginUrl: "file:///tmp/credential-boundary.mjs",
    cwd: "/repo",
    mcpCommand: ["node", "/app/mcp.js"],
    mcpEnvironment: {
      LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
      LETAGENTS_SUPERVISOR_PROVIDER: "open-model",
      OPENCODE_AUTH_CONTENT: "",
    },
  });
  const serialized = JSON.stringify(config);
  const provider = (config.provider as Record<string, Record<string, unknown>>)
    ["letagents-open-model"];
  const configuredModel = (
    provider.models as Record<string, Record<string, unknown>>
  )["qwen/qwen3-coder"];
  const mcp = (config.mcp as Record<string, Record<string, unknown>>).letagents;

  assert.equal(config.model, "letagents-open-model/qwen/qwen3-coder");
  assert.equal(config.autoupdate, false);
  assert.equal(config.share, "disabled");
  assert.equal(config.formatter, false);
  assert.equal(config.lsp, false);
  assert.equal((provider.options as Record<string, unknown>).baseURL, "https://openrouter.ai/api/v1");
  assert.equal(
    (configuredModel.limit as Record<string, unknown>).output,
    8_192,
  );
  assert.deepEqual(mcp.command, ["node", "/app/mcp.js"]);
  assert.equal(
    (mcp.environment as Record<string, string>).LETAGENTS_EXECUTION_PROFILE,
    "supervised_room_turn",
  );
  assert.equal((mcp.environment as Record<string, string>).OPENCODE_AUTH_CONTENT, "");
  assert.doesNotMatch(serialized, /provider-secret|apiKey|api_key/);
});

test("OpenCode runtime resolution and install command stay pinned", () => {
  assert.equal(
    resolveOpenCodeBinary({ LETAGENTS_OPENCODE_BIN: "/custom/opencode" }, ""),
    "/custom/opencode",
  );
  const install = openCodeInstallCommand();
  assert.equal(install.command, "npm");
  assert.deepEqual(install.args, [
    "install",
    "--global",
    `opencode-ai@${OPENCODE_RUNTIME_VERSION}`,
  ]);
  assert.match(install.detail, /does not require its own account/i);
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

test("Open Model is a daemon-supervised OpenCode provider", () => {
  const providers = listDesktopAgentProviders();
  const codex = providers.find((provider) => provider.id === "codex");
  const claude = providers.find((provider) => provider.id === "claude-code");
  const openModel = providers.find((provider) => provider.id === "open-model");

  assert.ok(codex?.capabilities.includes("supervised_runtime"));
  assert.ok(claude?.capabilities.includes("supervised_runtime"));
  assert.equal(
    claude?.capabilities.includes("desktop_managed_runtime"),
    false,
    "the former in-app Claude Agent SDK runtime is no longer selectable",
  );
  assert.ok(openModel?.capabilities.includes("desktop_managed_runtime"));
  assert.ok(openModel?.capabilities.includes("supervised_runtime"));
  assert.equal(openModel?.runtimeCommand, "opencode");
  assert.equal(openModel?.mcpTargetId, null);
});

test("supervised provider admission declares provider-neutral daemon delivery", () => {
  assert.equal(supervisedDeliveryModeForProvider("codex"), "daemon_inbox");
  assert.equal(supervisedDeliveryModeForProvider("open-model"), "daemon_inbox");
  assert.equal(supervisedDeliveryModeForProvider("claude-code"), "daemon_inbox");
  assert.throws(
    () => supervisedDeliveryModeForProvider("cursor"),
    /not available through the supervised engine/,
  );
});

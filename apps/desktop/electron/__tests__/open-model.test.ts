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
import { resolveOpenModelLimits } from "../main/agents/open-model-limits.js";
import { openCodeConfig, parseConfiguredOpenModelImageInput } from "../main/agents/opencode-launch-contract.js";
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

test("Open Model preflight checks OpenCode and accepts a per-agent model", async (t) => {
  const { supervisorDaemonClient } = await import("../main/supervisor-daemon.js");
  t.mock.method(supervisorDaemonClient, "isRuntimeEnvironmentCurrent", async () => true);
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
    limits: { context: 262144, output: 8192 },
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
  assert.deepEqual(config.permission, { "*": "allow" });
  assert.equal((configuredModel.limit as Record<string, unknown>).context, 262144);
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

  assert.deepEqual(openCodeConfig({
    limits: { context: 262144, output: 8192 },
    model: "qwen/qwen3-coder",
    baseUrl: "https://openrouter.ai/api/v1",
    pluginUrl: "file:///tmp/credential-boundary.mjs",
    cwd: "/repo",
    mcpCommand: ["node", "/app/mcp.js"],
    mcpEnvironment: {},
    permissionProfileId: "ask_before_write",
  }).permission, { "*": "allow", edit: "ask", bash: "ask" });
});

test("OpenCode config lists image input for the model only when the owner says it reads images", () => {
  const input = {
    model: "qwen/qwen3-coder",
    limits: { context: 262144, output: 8192 },
    baseUrl: "https://openrouter.ai/api/v1",
    pluginUrl: "file:///tmp/credential-boundary.mjs",
    cwd: "/repo",
    mcpCommand: ["node", "/app/mcp.js"],
    mcpEnvironment: {},
  };
  const modelOf = (config: ReturnType<typeof openCodeConfig>) =>
    ((config.provider as Record<string, Record<string, unknown>>)["letagents-open-model"]!
      .models as Record<string, Record<string, unknown>>)["qwen/qwen3-coder"]!;

  for (const config of [openCodeConfig(input), openCodeConfig({ ...input, imageInput: false })]) {
    assert.equal("modalities" in modelOf(config), false, "a model is never claimed to read images by default");
    assert.equal(parseConfiguredOpenModelImageInput(config), false);
  }
  const withImages = openCodeConfig({ ...input, imageInput: true });
  assert.deepEqual(modelOf(withImages).modalities, { input: ["text", "image"], output: ["text"] });
  assert.equal(parseConfiguredOpenModelImageInput(withImages), true);
  assert.equal(
    parseConfiguredOpenModelImageInput(JSON.parse(JSON.stringify(withImages))),
    true,
    "the setting survives the JSON the runtime serves back from /config",
  );
  assert.deepEqual(
    { ...modelOf(withImages), modalities: undefined },
    { ...modelOf(openCodeConfig(input)), modalities: undefined },
    "image input changes nothing else about the model",
  );
});

test("a runtime configuration reads as image input only for its own configured model with an image modality", () => {
  const config = (overrides: Record<string, unknown>) => ({
    model: "letagents-open-model/qwen/qwen3-coder",
    provider: { "letagents-open-model": { models: { "qwen/qwen3-coder": {} } } },
    ...overrides,
  }) as unknown as Parameters<typeof parseConfiguredOpenModelImageInput>[0];
  const withModalities = (modalities: unknown, model = "qwen/qwen3-coder") => config({
    provider: { "letagents-open-model": { models: { [model]: { modalities } } } },
  });

  assert.equal(parseConfiguredOpenModelImageInput(withModalities({ input: ["text", "image"], output: ["text"] })), true);
  assert.equal(parseConfiguredOpenModelImageInput(withModalities({ input: ["text"], output: ["text"] })), false);
  assert.equal(parseConfiguredOpenModelImageInput(withModalities({ input: "image" })), false, "input must be a list");
  assert.equal(parseConfiguredOpenModelImageInput(withModalities({ output: ["image"] })), false, "output modalities do not count");
  assert.equal(parseConfiguredOpenModelImageInput(withModalities(null)), false);
  assert.equal(
    parseConfiguredOpenModelImageInput(withModalities({ input: ["image"] }, "another/model")),
    false,
    "another model's modalities do not count",
  );
  assert.equal(parseConfiguredOpenModelImageInput(config({})), false);
  assert.equal(parseConfiguredOpenModelImageInput(config({ provider: undefined })), false);
  assert.equal(parseConfiguredOpenModelImageInput(config({ model: undefined })), false, "no configured Open Model");
  assert.equal(
    parseConfiguredOpenModelImageInput({
      model: "other-provider/qwen/qwen3-coder",
      provider: { "other-provider": { models: { "qwen/qwen3-coder": { modalities: { input: ["image"] } } } } },
    } as never),
    false,
    "only the Open Model provider counts",
  );
});

test("OpenCode runtime resolution and install command stay pinned", () => {
  assert.equal(
    resolveOpenCodeBinary({ LETAGENTS_OPENCODE_BIN: "/custom/opencode" }, ""),
    "/custom/opencode",
  );
  const resources = join("packaged", "resources");
  const present = (expected: string) => (path: string) => path === expected;
  assert.equal(
    resolveOpenCodeBinary({}, resources, "darwin", present(join(resources, "app", "runtime", "opencode"))),
    join(resources, "app", "runtime", "opencode"),
  );
  assert.equal(
    resolveOpenCodeBinary({}, resources, "win32", present(join(resources, "app", "runtime", "opencode.exe"))),
    join(resources, "app", "runtime", "opencode.exe"),
  );
  // A Windows package never runs the extensionless macOS name.
  assert.equal(
    resolveOpenCodeBinary({}, resources, "win32", present(join(resources, "app", "runtime", "opencode"))),
    "opencode",
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
  assert.equal(
    assertManagedAgentPermissionProfileAvailable("open-model", "ask_before_write").status,
    "available",
  );
  assert.throws(
    () => assertManagedAgentPermissionProfileAvailable("open-model", "read_only"),
    /not available/,
  );
});

test("desktop-managed providers declare their supervised runtimes", () => {
  const providers = listDesktopAgentProviders();
  const codex = providers.find((provider) => provider.id === "codex");
  const claude = providers.find((provider) => provider.id === "claude-code");
  const cursor = providers.find((provider) => provider.id === "cursor");
  const openModel = providers.find((provider) => provider.id === "open-model");

  assert.ok(codex?.capabilities.includes("supervised_runtime"));
  assert.ok(claude?.capabilities.includes("supervised_runtime"));
  for (const provider of providers) {
    assert.equal(
      (provider.capabilities as readonly string[]).includes("desktop_managed_runtime"),
      false,
      `${provider.id} must not declare the retired in-app runtime capability`,
    );
  }
  assert.ok(openModel?.capabilities.includes("supervised_runtime"));
  assert.equal(openModel?.runtimeCommand, "opencode");
  assert.equal(openModel?.mcpTargetId, null);
  assert.ok(cursor?.capabilities.includes("supervised_runtime"));
  assert.equal(cursor?.supervisedDeliveryMode, "daemon_inbox");
});

test("supervised provider admission declares provider-neutral daemon delivery", () => {
  assert.equal(supervisedDeliveryModeForProvider("codex"), "daemon_inbox");
  assert.equal(supervisedDeliveryModeForProvider("open-model"), "daemon_inbox");
  assert.equal(supervisedDeliveryModeForProvider("claude-code"), "daemon_inbox");
  assert.equal(supervisedDeliveryModeForProvider("cursor"), "daemon_inbox");
});


test("Open Model resolves the exact endpoint model's capacity and output budget", async () => {
  const metadata = async (url: string, init?: RequestInit) => {
    assert.equal(url, "https://provider.example/v1/models?region=us");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
    assert.equal(init?.redirect, "error");
    return Response.json({ data: [
      { id: "small", context_length: 16000, max_output_tokens: 2000 },
      { id: "glm-5.3", context_length: 262144, top_provider: { context_length: 262144, max_completion_tokens: 32768 } },
    ] });
  };
  const input = { baseUrl: "https://provider.example/v1?region=us", apiKey: "secret", model: "glm-5.3" };
  assert.deepEqual(await resolveOpenModelLimits(input, metadata), { context: 262144, output: 8192 });
  assert.deepEqual(await resolveOpenModelLimits({ ...input, model: "small" }, metadata), { context: 16000, output: 2000 });
  await assert.rejects(resolveOpenModelLimits({ ...input, model: "glm-5.3-alias" }, metadata), /context window/);
  assert.deepEqual(await resolveOpenModelLimits({ ...input, contextWindow: 32000 }, async () => assert.fail("explicit limit needs no network")),
    { context: 32000, output: 8000 });
});

test("Open Model requires an explicit limit when endpoint metadata is missing or invalid", async () => {
  const input = { baseUrl: "https://provider.example/v1", apiKey: null, model: "local" };
  for (const value of [undefined, 0, -1, 2.5, "262144", 1]) {
    await assert.rejects(resolveOpenModelLimits(input, async () => Response.json({ data: [{ id: "local", context_length: value }] })), /Set its context window/);
  }
  await assert.rejects(resolveOpenModelLimits(input, async () => Response.json({ data: [{
    id: "local", context_length: 262144, top_provider: { context_length: 1 },
  }] })), /Set its context window/);
  await assert.rejects(resolveOpenModelLimits(input, async () => { throw new Error("api_key=secret"); }), (error: unknown) => {
    assert.doesNotMatch(String(error), /api_key|secret/); return true;
  });
  await assert.rejects(resolveOpenModelLimits({ ...input, contextWindow: NaN }), /whole number/);
});

test("saved context limits stay with their endpoint and model", async () => {
  const storePath = await tempSettingsPath();
  const options = { storePath, secretStorage };
  const saved = await saveOpenModelSettings({ baseUrl: "https://provider.example/v1", model: "glm-5.3", contextWindow: 262144 }, options);
  assert.equal(saved.contextWindow, 262144);
  assert.equal((await saveOpenModelSettings({ apiKey: "new-key" }, options)).contextWindow, 262144);
  assert.equal((await saveOpenModelSettings({ model: "smaller-model" }, options)).contextWindow, null);
  await saveOpenModelSettings({ contextWindow: 32000 }, options);
  assert.equal((await saveOpenModelSettings({ baseUrl: "http://localhost:8000/v1" }, options)).contextWindow, null);
  await assert.rejects(saveOpenModelSettings({ contextWindow: -1 }, options), /whole number/);
});

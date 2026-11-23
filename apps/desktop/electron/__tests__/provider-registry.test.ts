import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({ prefix: "letagents-provider-registry-", paths: [] });

const { cursorRuntimeInstallCommand, listDesktopAgentProviders } = await import("../main/agents/provider-registry.js");

test("listDesktopAgentProviders lists every desktop-managed provider", () => {
  const providers = listDesktopAgentProviders();
  const codex = providers.find((provider) => provider.id === "codex");
  assert.equal(
    codex?.runtimeCommand,
    "codex",
    "Codex launch sites assume the registry uses the canonical command name",
  );
  assert.equal(codex?.capabilities.includes("installable_runtime"), false);
  assert.equal(codex?.authCommand, undefined, "normal installed sign-in commands remain unchanged");
  assert.match(codex?.runtimeInstallCommand || "", /chatgpt\.com\/codex\/install/);
  assert.equal(codex?.runtimeInstallUrl, "https://learn.chatgpt.com/docs/codex/cli");
  assert.equal(
    providers.find((provider) => provider.id === "open-model")
      ?.capabilities.includes("installable_runtime"),
    true,
    "only the LetAgents-managed Open Model engine remains installable",
  );
  const antigravity = providers.find((provider) => provider.id === "antigravity");
  assert.ok(antigravity, "Antigravity is offered as a desktop-managed agent");
  assert.equal(antigravity.runtimeCommand, "agy");
  assert.equal(antigravity.supervisedDeliveryMode, "daemon_inbox");
  assert.ok(antigravity.capabilities.includes("supervised_runtime"));
  assert.ok(antigravity.capabilities.includes("turn_control"));
  assert.equal(antigravity.capabilities.includes("installable_runtime"), false, "LetAgents does not install agy");
  assert.match(antigravity.runtimeInstallCommand || "", /antigravity\.google\/cli\/install/);
  assert.equal(antigravity.defaultPermissionProfileId, "read_only");
  assert.deepEqual(
    antigravity.permissionProfiles.filter((profile) => profile.status === "available").map((profile) => profile.id),
    ["read_only", "ask_before_write", "auto_review", "full_access"],
  );
});

test("Preview sign-in commands preserve private homes and exclude terminal credentials", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "preview-sign-in-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "Preview's $(must-not-execute)");
  const marker = Symbol.for("letagents.isolated-desktop-preview");
  Object.defineProperty(globalThis, marker, { value: "agent-room-refresh", configurable: true });
  const environment = {
    HOME: home, CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
    TMPDIR: join(root, "tmp"), PATH: `${root}:/usr/bin:/bin`,
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    Reflect.deleteProperty(globalThis, marker);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const fixture = `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), environment: Object.fromEntries(${JSON.stringify(Object.keys(environment))}.map(key => [key, process.env[key]])), inherited: [process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY, process.env.CLAUDE_CODE_OAUTH_TOKEN, process.env.NODE_OPTIONS] }));\n`;
  await Promise.all(["codex", "claude"].map((name) => writeFile(join(root, name), fixture, { mode: 0o700 })));
  const providers = listDesktopAgentProviders();
  for (const [id, args] of [["codex", ["login"]], ["claude-code", ["auth", "login"]]] as const) {
    const command = providers.find((provider) => provider.id === id)!.authCommand!;
    const output = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", env: {
      ...process.env, OPENAI_API_KEY: "terminal-key", ANTHROPIC_API_KEY: "other-terminal-key", CLAUDE_CODE_OAUTH_TOKEN: "terminal-token", NODE_OPTIONS: "--trace-warnings",
    } });
    assert.deepEqual(JSON.parse(output), { args, environment, inherited: [null, null, null, null] });
    assert.equal(providers.find((provider) => provider.id === id)!.runtimeCommand, id === "codex" ? "codex" : "claude");
  }
  assert.equal(providers.find((provider) => provider.id === "cursor")!.authCommand, undefined);
  delete process.env.CODEX_HOME;
  assert.throws(() => listDesktopAgentProviders(), /Preview sign-in environment is unavailable/, "never fall back to normal auth if Preview isolation is incomplete");
});

test("external runtime install commands stay valid for the current platform", () => {
  assert.equal(cursorRuntimeInstallCommand("win32"), null);
  assert.match(cursorRuntimeInstallCommand("darwin") || "", /curl .* \| bash/);
  assert.match(cursorRuntimeInstallCommand("linux") || "", /curl .* \| bash/);
});

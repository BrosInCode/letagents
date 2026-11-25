import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveCodexExecutable } from "#provider-runtime/agents/codex-executable.js";
import { codexGuestToolsLocked, disallowedGuestCodexTools, isGuestCodexToolSet, probeCodexGuestTools } from "#provider-runtime/agents/codex-guest-lock.js";

test("a guest Codex may be offered only the room's tools and allowlisted tools that reach nothing local", () => {
  assert.equal(isGuestCodexToolSet(["mcp__letagents__read_messages", "list_mcp_resources", "request_user_input"]), true);
  assert.equal(isGuestCodexToolSet(["mcp__letagents__read_messages", "functions.send_message_to_user_async"]), true);
  for (const tool of ["exec_command", "view_image", "web_search", "mcp__codex_apps__gmail", "multi_agent_v1", "apply_patch", "collaboration.spawn_agent", "collaboration.send_message"]) {
    assert.equal(isGuestCodexToolSet(["mcp__letagents__read_messages", tool]), false, tool);
    assert.deepEqual(disallowedGuestCodexTools(["mcp__letagents__read_messages", tool]), { tools: [tool], nested: [], unparsedCodeMode: false }, tool);
  }
});

test("the lock fails closed when the probe sees a local tool or sees nothing", async () => {
  const seen = (tools: string[], nestedText = "") => async () => ({ tools, nestedText });
  assert.equal(await codexGuestToolsLocked("/fake/codex-a", {}, null, seen(["exec_command"])), false);
  assert.equal(await codexGuestToolsLocked("/fake/codex-b", {}, null, async () => null), false);
  assert.equal(await codexGuestToolsLocked("/fake/codex-c", {}, null, async () => { throw new Error("boom"); }), false);
  assert.equal(await codexGuestToolsLocked("/fake/codex-d", {}, null, seen(["mcp__letagents__send_message"])), true);
  // Code mode: exec is fine only while its nested tools reach nothing local, and collaboration.* is rejected.
  assert.equal(await codexGuestToolsLocked("/fake/codex-e", {}, null, seen(["functions.exec", "functions.wait", "functions.send_message_to_user_async", "clock.sleep"], "for example `await tools.exec_command(...)`\n### `apply_patch`\n### `clock__curr_time`")), true);
  assert.equal(await codexGuestToolsLocked("/fake/codex-e2", {}, null, seen(["functions.exec", "collaboration.spawn_agent"], "### `apply_patch`\n### `clock__curr_time`")), false);
  assert.equal(await codexGuestToolsLocked("/fake/codex-f", {}, null, seen(["functions.exec"], "### `exec_command`\nRuns a shell command.")), false);
  assert.deepEqual(disallowedGuestCodexTools({ tools: ["functions.exec"], nestedText: "### `exec_command`\nRuns a shell command." }), { tools: [], nested: ["exec_command"], unparsedCodeMode: false });
  // Nested tools are an allowlist: a new or unknown one is refused, and so is exec with nothing parsed.
  assert.equal(await codexGuestToolsLocked("/fake/codex-g", {}, null, seen(["functions.exec"], "### `mcp__letagents__send_message`\n### `brand_new_tool`")), false);
  assert.equal(await codexGuestToolsLocked("/fake/codex-h", {}, null, seen(["functions.exec"], "Run JavaScript with tools.")), false);
  assert.deepEqual(disallowedGuestCodexTools({ tools: ["functions.exec"], nestedText: "Run JavaScript with tools." }), { tools: [], nested: [], unparsedCodeMode: true });
  assert.equal(await codexGuestToolsLocked("/fake/codex-i", {}, null, seen([])), false);
});

/** A fake npm-installed `codex`: a Node wrapper that starts the "native" process and records its pid. */
function fakeNpmCodex(t: { after(fn: () => void): void }, wrapperWaits: boolean) {
  const folder = mkdtempSync(join(tmpdir(), "codex-shim-"));
  const pids = join(folder, "pids");
  const shim = join(folder, "codex");
  writeFileSync(shim, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
if (process.argv[2] === "mcp") { process.stdout.write("[]"); process.exit(0); }
const native = spawn("sleep", ["300"], { stdio: "ignore" });
require("node:fs").appendFileSync(${JSON.stringify(pids)}, native.pid + "\\n");
${wrapperWaits ? 'native.on("exit", () => process.exit(0));' : "native.unref(); process.exit(0);"}
`);
  chmodSync(shim, 0o755);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const started = () => { try { return readFileSync(pids, "utf8").trim().split("\n").filter(Boolean).map(Number); } catch { return []; } };
  t.after(() => {
    for (const pid of started()) if (alive(pid)) process.kill(pid, "SIGKILL");
    rmSync(folder, { recursive: true, force: true });
  });
  // HOME and CODEX_HOME point inside the folder, so nothing from the real home is read.
  return { shim, env: { ...process.env, HOME: folder, CODEX_HOME: folder }, started, alive };
}

for (const [name, wrapperWaits] of [["the npm wrapper exits first", false], ["the probe times out", true]] as const) {
  test(`the probe leaves no Codex process behind when ${name}`, { skip: process.platform === "win32" && "no process groups" }, async t => {
    const fake = fakeNpmCodex(t, wrapperWaits);
    assert.equal(await probeCodexGuestTools(fake.shim, fake.env, null, 1_000), null);
    const [native] = fake.started();
    assert.ok(native, "the native process started");
    for (let i = 0; i < 50 && fake.alive(native); i += 1) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fake.alive(native), false, "the native process was stopped with its wrapper");
  });
}

function installedCodex(): string | null {
  if (process.env.LETAGENTS_SKIP_CODEX_CONTRACT === "1") return null;
  const bin = resolveCodexExecutable();
  const home = mkdtempSync(join(tmpdir(), "codex-guest-version-"));
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 10_000, env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex") } });
    return bin;
  } catch {
    return null;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const codexBin = installedCodex();

function formatDisallowed(probe: NonNullable<Awaited<ReturnType<typeof probeCodexGuestTools>>>): string {
  const bad = disallowedGuestCodexTools(probe);
  const parts = [
    ...(bad.tools.length ? [`disallowed tools: ${bad.tools.join(", ")}`] : []),
    ...(bad.nested.length ? [`disallowed nested tools: ${bad.nested.join(", ")}`] : []),
    ...(bad.unparsedCodeMode ? ["code-mode nested tools did not parse"] : []),
  ];
  return `${parts.join("; ")} (all seen: ${probe.tools.join(", ")})`;
}

for (const [label, model, cleanHome] of [
  ["default (clean CODEX_HOME)", null, true],
  ["default (owner env)", null, false],
  ["gpt-5", "gpt-5", false],
  ["gpt-6-astra", "gpt-6-astra", false],
  ["gpt-6.2-sol", "gpt-6.2-sol", false],
] as const) {
  test(`the installed Codex, set up as a guest, offers no tool that reaches this Mac (model ${label})`, { skip: !codexBin && "codex is not installed" }, async t => {
    let probeEnv = process.env;
    if (cleanHome) {
      const home = mkdtempSync(join(tmpdir(), "codex-guest-clean-home-"));
      mkdirSync(join(home, ".codex"), { recursive: true });
      t.after(() => rmSync(home, { recursive: true, force: true }));
      probeEnv = { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex") };
    }
    const seen = await probeCodexGuestTools(codexBin!, probeEnv, model);
    assert.ok(seen, "Codex sent its tool list to the probe");
    assert.ok(isGuestCodexToolSet(seen!), formatDisallowed(seen!));
    assert.ok(!seen!.tools.includes("exec_command") && !seen!.tools.includes("view_image"));
    assert.ok(!seen!.tools.some(tool => tool.startsWith("collaboration.")), `collaboration tools were not disabled: ${seen!.tools.join(", ")}`);
  });
}

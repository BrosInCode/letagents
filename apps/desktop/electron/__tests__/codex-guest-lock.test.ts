import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { codexGuestToolsLocked, isGuestCodexToolSet, probeCodexGuestTools } from "../main/agents/codex-guest-lock.js";

test("a guest Codex may be offered only the room's tools and four that read nothing local", () => {
  assert.equal(isGuestCodexToolSet(["mcp__letagents__read_messages", "list_mcp_resources", "request_user_input"]), true);
  for (const tool of ["exec_command", "view_image", "web_search", "mcp__codex_apps__gmail", "multi_agent_v1", "apply_patch"]) {
    assert.equal(isGuestCodexToolSet(["mcp__letagents__read_messages", tool]), false, tool);
  }
});

test("the lock fails closed when the probe sees a local tool or sees nothing", async () => {
  const seen = (tools: string[], nestedText = "") => async () => ({ tools, nestedText });
  assert.equal(await codexGuestToolsLocked("/fake/codex-a", {}, null, seen(["exec_command"])), false);
  assert.equal(await codexGuestToolsLocked("/fake/codex-b", {}, null, async () => null), false);
  assert.equal(await codexGuestToolsLocked("/fake/codex-c", {}, null, async () => { throw new Error("boom"); }), false);
  assert.equal(await codexGuestToolsLocked("/fake/codex-d", {}, null, seen(["mcp__letagents__send_message"])), true);
  // Code mode: exec is fine only while its nested tools reach nothing local.
  assert.equal(await codexGuestToolsLocked("/fake/codex-e", {}, null, seen(["functions.exec", "collaboration.spawn_agent"], "for example `await tools.exec_command(...)`\n### `apply_patch`\n### `clock__curr_time`")), true);
  assert.equal(await codexGuestToolsLocked("/fake/codex-f", {}, null, seen(["functions.exec"], "### `exec_command`\nRuns a shell command.")), false);
  // Nested tools are an allowlist: a new or unknown one is refused, and so is exec with nothing parsed.
  assert.equal(await codexGuestToolsLocked("/fake/codex-g", {}, null, seen(["functions.exec"], "### `mcp__letagents__send_message`\n### `brand_new_tool`")), false);
  assert.equal(await codexGuestToolsLocked("/fake/codex-h", {}, null, seen(["functions.exec"], "Run JavaScript with tools.")), false);
  assert.equal(await codexGuestToolsLocked("/fake/codex-i", {}, null, seen([])), false);
});

test("the probe leaves no Codex process behind when an npm wrapper exits first", { skip: process.platform === "win32" && "no process groups" }, async () => {
  const folder = mkdtempSync(join(tmpdir(), "codex-shim-"));
  const pids = join(folder, "pids");
  const shim = join(folder, "codex");
  // Like npm's wrapper: start the "native" process, then exit without waiting for it.
  writeFileSync(shim, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
if (process.argv[2] === "exec") {
  const native = spawn("sleep", ["300"], { stdio: "ignore" });
  require("node:fs").appendFileSync(${JSON.stringify(pids)}, native.pid + "\\n");
  native.unref();
}
if (process.argv[2] === "mcp") process.stdout.write("[]");
process.exit(0);
`);
  chmodSync(shim, 0o755);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(await probeCodexGuestTools(shim, { ...process.env, CODEX_HOME: folder }, null), null);
  const started = readFileSync(pids, "utf8").trim().split("\n").map(Number);
  assert.equal(started.length, 1);
  for (let i = 0; i < 50 && alive(started[0]!); i += 1) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(alive(started[0]!), false, "the native process was stopped with its wrapper");
});

let codexBin: string | null = null;
try { codexBin = execFileSync("/usr/bin/which", ["codex"], { encoding: "utf8" }).trim() || null; } catch { codexBin = null; }

for (const model of [null, "gpt-5", "gpt-6-astra"]) {
  test(`the installed Codex, set up as a guest, offers no tool that reaches this Mac (model ${model ?? "default"})`, { skip: !codexBin && "codex is not installed" }, async () => {
    const seen = await probeCodexGuestTools(codexBin!, process.env, model);
    assert.ok(seen, "Codex sent its tool list to the probe");
    assert.ok(isGuestCodexToolSet(seen!), `unexpected tools: ${seen!.tools.join(", ")}`);
    assert.ok(!seen!.tools.includes("exec_command") && !seen!.tools.includes("view_image"));
  });
}

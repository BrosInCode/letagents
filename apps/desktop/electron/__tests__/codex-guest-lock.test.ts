import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

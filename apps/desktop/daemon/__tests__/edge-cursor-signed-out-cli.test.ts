import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// The stand-in `cursor-agent` of the daemon edge tests, tested by itself.

const CLI = fileURLToPath(new URL("./edge/cursor/signed-out-cli.mjs", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "edge-cursor-signed-out-"));
after(() => rmSync(home, { recursive: true, force: true }));

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("the signed-out stand-in cursor-agent of the daemon edge tests", () => {
  it("reports the one MCP server of the profile as ready, with nothing on stderr", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { letagents_supervised_abc123: {} } }));
    assert.deepEqual(run(["--disable-project-configs", "mcp", "list"]), {
      status: 0, stdout: "letagents_supervised_abc123: ready\n", stderr: "",
    });
  });

  it("answers the identity check as not signed in", () => {
    const result = run(["--endpoint", "http://127.0.0.1:1", "--http-version", "1.1", "--disable-auto-update", "status", "--format", "json"]);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { status: "unauthenticated", isAuthenticated: false });
  });

  it("refuses a turn, and notes every start in the profile", () => {
    const result = run(["-p", "--output-format", "stream-json", "a prompt"]);
    assert.equal(result.status, 70);
    assert.equal(result.stdout, "");
    const kinds = readFileSync(join(home, "edge-cursor-calls.ndjson"), "utf8").trim().split("\n")
      .map((line) => (JSON.parse(line) as { kind: string }).kind);
    assert.deepEqual(kinds, ["mcp_list", "status", "unexpected_start"]);
  });
});

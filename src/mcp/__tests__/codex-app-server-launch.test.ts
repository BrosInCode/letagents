import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { codexAppServerArgs, launchAppServer } from "../codex-session/app-server.js";
import { CODEX_OWNER_FEATURE_OVERRIDES } from "../../../shared/codex-owner-isolation.mjs";

test("a local Codex session's app-server leaves the owner's Codex extensions off", async () => {
  assert.deepEqual(codexAppServerArgs("ws://127.0.0.1:4500"), [
    "app-server",
    ...CODEX_OWNER_FEATURE_OVERRIDES.flatMap((override) => ["-c", override]),
    "--listen",
    "ws://127.0.0.1:4500",
  ]);
  for (const flag of ["features.plugins=false", "features.computer_use=false", "features.hooks=false", "notify=[]"]) {
    assert.ok(CODEX_OWNER_FEATURE_OVERRIDES.includes(flag), flag);
  }

  const directory = mkdtempSync(join(tmpdir(), "letagents-mcp-codex-launch-"));
  try {
    const report = join(directory, "argv.json");
    const bin = join(directory, "codex");
    writeFileSync(bin, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(report)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    assert.notEqual(launchAppServer("ws://127.0.0.1:1", bin), null);
    for (let attempt = 0; attempt < 100 && !existsSync(report); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), codexAppServerArgs("ws://127.0.0.1:1"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

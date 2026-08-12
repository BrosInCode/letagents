/**
 * Tests for p5.3 Command Broker policy and execution.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { evaluateCommandPolicy } from "../rental/command-broker-policy.js";
import {
  runWorkspaceCommand,
  type CommandBrokerDeps,
  type CommandBrokerManifest,
} from "../rental/command-broker.js";

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "command-broker-test-"));
  await fs.writeFile(
    path.join(workspaceRoot, "sample.test.mjs"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'test("ok", () => assert.equal(1 + 1, 2));',
    ].join("\n"),
  );
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

function makeDeps(): CommandBrokerDeps {
  const manifest: CommandBrokerManifest = {
    id: "manifest_1",
    session_id: "rsess_1",
    workspace_path: workspaceRoot,
    retention_status: "active",
  };
  return {
    async getActiveManifest() {
      return manifest;
    },
  };
}

describe("evaluateCommandPolicy", () => {
  it("allows test/check style commands only", () => {
    assert.equal(evaluateCommandPolicy(["npm", "test"]).allowed, true);
    assert.equal(evaluateCommandPolicy(["npm", "exec", "tsc", "--", "--noEmit"]).allowed, true);
    assert.equal(evaluateCommandPolicy(["node", "--test", "sample.test.mjs"]).allowed, true);
    assert.equal(evaluateCommandPolicy(["npm", "install"]).allowed, false);
    assert.equal(evaluateCommandPolicy(["bash", "-lc", "npm test"]).allowed, false);
    assert.equal(evaluateCommandPolicy(["node", "--test", "x.test.mjs;rm"]).allowed, false);
  });
});

describe("runWorkspaceCommand", () => {
  it("runs an allowed node test command in the workspace", async () => {
    const result = await runWorkspaceCommand(makeDeps(), {
      sessionId: "rsess_1",
      argv: ["node", "--test", "sample.test.mjs"],
      timeoutMs: 10_000,
    });

    assert.equal(result.success, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout ?? "", /pass 1/);
  });

  it("blocks non-test commands before workspace execution", async () => {
    const result = await runWorkspaceCommand(makeDeps(), {
      sessionId: "rsess_1",
      argv: ["npm", "install"],
    });

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /command_blocked/);
  });
});

// ---------------------------------------------------------------------------
// Supply-chain rails
// ---------------------------------------------------------------------------

describe("runWorkspaceCommand supply-chain environment", () => {
  it("commands run with offline package-manager rails and isolated home", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, "env-rails.test.mjs"),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'test("supply-chain env rails", () => {',
        '  assert.equal(process.env.npm_config_offline, "true");',
        '  assert.equal(process.env.COREPACK_ENABLE_NETWORK, "0");',
        '  assert.equal(process.env.YARN_ENABLE_NETWORK, "false");',
        '  assert.equal(process.env.CI, "1");',
        '  assert.ok(process.env.HOME.includes(".letagents-command-home"));',
        '  assert.ok(process.env.npm_config_cache.includes(".letagents-npm-cache"));',
        "});",
      ].join("\n"),
    );

    const result = await runWorkspaceCommand(makeDeps(), {
      sessionId: "rsess_1",
      argv: ["node", "--test", "env-rails.test.mjs"],
    });
    assert.equal(result.success, true, result.stderr ?? result.error);
  });

  it("npm exec never downloads an uncached package from the registry", async () => {
    // The rail under test: offline mode + empty per-workspace cache
    // means npm exec can never DOWNLOAD anything. The command may still
    // succeed by resolving a host-global binary (npm checks global
    // installs before the registry, and e.g. `npm i -g typescript` is
    // common on dev machines) — that is host-admin-controlled code, not
    // a registry fetch, so the assertion is outcome-agnostic: on
    // failure it must be a cache miss (never a network fetch), and in
    // both outcomes nothing may have been downloaded or installed.
    const result = await runWorkspaceCommand(makeDeps(), {
      sessionId: "rsess_1",
      argv: ["npm", "exec", "tsc", "--", "--version"],
      timeoutMs: 60_000,
    });
    if (!result.success) {
      assert.match(
        `${result.stderr ?? ""} ${result.stdout ?? ""} ${result.error ?? ""}`,
        /ENOTCACHED|not found|could not determine executable/i,
        "offline npm exec must fail as a cache miss, not a network error",
      );
    }
    assert.ok(
      !(await fs.stat(path.join(workspaceRoot, "node_modules"))
        .then(() => true)
        .catch(() => false)),
      "no packages may be installed into the workspace",
    );
    const cacheContent = path.join(
      workspaceRoot,
      ".letagents-npm-cache",
      "_cacache",
      "content-v2",
    );
    assert.ok(
      !(await fs.stat(cacheContent).then(() => true).catch(() => false)),
      "nothing may be downloaded into the per-workspace npm cache",
    );
  });
});

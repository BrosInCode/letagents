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

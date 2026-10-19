import "./isolated-home.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCursorChildEnv,
  buildCursorAgentArgs,
} from "../main/agents/cursor-runner.js";

test("Cursor runner args use read-only stream-json mode and avoid unsafe flags", () => {
  const args = buildCursorAgentArgs({
    prompt: "hello",
    cwd: "/tmp/repo",
    cursorSessionId: "cursor_session_1",
    mode: "plan",
  });

  assert.deepEqual(args, [
    "-p",
    "--output-format",
    "stream-json",
    "--trust",
    "--workspace",
    "/tmp/repo",
    "--mode",
    "plan",
    "--resume",
    "cursor_session_1",
    "hello",
  ]);
  assert.equal(args.includes("--force"), false);
  assert.equal(args.includes("--approve-mcps"), false);
  assert.equal(args.includes("--sandbox"), false);
});

test("Cursor runner args enable explicit write profiles", () => {
  assert.deepEqual(buildCursorAgentArgs({
    prompt: "write safely",
    cwd: "/tmp/repo",
    mode: null,
    force: true,
    sandbox: "enabled",
  }), [
    "-p",
    "--output-format",
    "stream-json",
    "--trust",
    "--workspace",
    "/tmp/repo",
    "--force",
    "--sandbox",
    "enabled",
    "write safely",
  ]);

  assert.deepEqual(buildCursorAgentArgs({
    prompt: "write freely",
    cwd: "/tmp/repo",
    mode: null,
    force: true,
    sandbox: "disabled",
  }), [
    "-p",
    "--output-format",
    "stream-json",
    "--trust",
    "--workspace",
    "/tmp/repo",
    "--force",
    "--sandbox",
    "disabled",
    "write freely",
  ]);
});

test("Cursor runner args include a selected model before the prompt", () => {
  assert.deepEqual(buildCursorAgentArgs({
    prompt: "use model",
    cwd: "/tmp/repo",
    cursorSessionId: "cursor_session_1",
    model: "gpt-5.3-codex-high",
  }), [
    "-p",
    "--output-format",
    "stream-json",
    "--trust",
    "--workspace",
    "/tmp/repo",
    "--mode",
    "ask",
    "--model",
    "gpt-5.3-codex-high",
    "--resume",
    "cursor_session_1",
    "use model",
  ]);
});

test("Cursor runner child env is allowlisted and applies managed overrides", () => {
  const previousValues = new Map<string, string | undefined>();
  for (const key of [
    "AWS_ACCESS_KEY_ID",
    "CURSOR_AUTH_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "LETAGENTS_API_URL",
    "LETAGENTS_TOKEN",
    "NPM_TOKEN",
    "PATH",
  ]) {
    previousValues.set(key, process.env[key]);
  }
  process.env.AWS_ACCESS_KEY_ID = "aws-secret";
  process.env.CURSOR_AUTH_TOKEN = "cursor-secret";
  process.env.GH_TOKEN = "gh-secret";
  process.env.GITHUB_TOKEN = "github-secret";
  process.env.LETAGENTS_TOKEN = "letagents-secret";
  process.env.LETAGENTS_API_URL = "https://letagents.example";
  process.env.NPM_TOKEN = "npm-secret";
  process.env.PATH = "/tmp/safe-path";
  try {
    const env = buildCursorChildEnv({
      GH_TOKEN: "override-gh-secret",
      HOME: "/tmp/managed-cursor-home",
      CURSOR_CONFIG_DIR: "/tmp/managed-cursor-config",
      LETAGENTS_TOKEN: "override-letagents-secret",
    });

    assert.equal(env.HOME, "/tmp/managed-cursor-home");
    assert.equal(env.CURSOR_CONFIG_DIR, "/tmp/managed-cursor-config");
    assert.equal(env.CURSOR_AUTH_TOKEN, "cursor-secret");
    assert.equal(env.PATH, "/tmp/safe-path");
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.LETAGENTS_TOKEN, undefined);
    assert.equal(env.LETAGENTS_API_URL, undefined);
    assert.equal(env.NPM_TOKEN, undefined);
  } finally {
    for (const [key, value] of previousValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

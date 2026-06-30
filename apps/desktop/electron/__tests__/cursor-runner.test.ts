import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyCursorStreamEvent,
  buildCursorAgentArgs,
  runCursorTurn,
  type CursorStreamState,
} from "../main/agents/cursor-runner.js";

const tempDir = mkdtempSync(join(tmpdir(), "letagents-cursor-runner-"));

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function script(name: string, body: string): string {
  const path = join(tempDir, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, "utf-8");
  chmodSync(path, 0o755);
  return path;
}

function emitJson(value: unknown): string {
  return `printf '%s\\n' '${JSON.stringify(value).replaceAll("'", "'\\''")}'`;
}

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
    "--mode",
    "plan",
    "--trust",
    "--workspace",
    "/tmp/repo",
    "--resume",
    "cursor_session_1",
    "hello",
  ]);
  assert.equal(args.includes("--force"), false);
  assert.equal(args.includes("--approve-mcps"), false);
  assert.equal(args.includes("--sandbox"), false);
});

test("Cursor runner parses a successful stream-json turn", async () => {
  const cursorBin = script("cursor-success", [
    emitJson({
      type: "system",
      subtype: "init",
      session_id: "cursor_session_1",
      model: "Composer 2.5 Fast",
      permissionMode: "default",
    }),
    emitJson({
      type: "assistant",
      session_id: "cursor_session_1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello from cursor" }],
      },
    }),
    emitJson({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "hello from cursor",
      session_id: "cursor_session_1",
    }),
  ].join("\n"));

  const result = await runCursorTurn({
    prompt: "hello",
    cwd: tempDir,
    cursorBin,
  });

  assert.equal(result.status, "success");
  assert.equal(result.sessionId, "cursor_session_1");
  assert.equal(result.text, "hello from cursor");
  assert.equal(result.error, null);
  assert.deepEqual(
    result.recentItems.map((item) => item.type),
    ["system", "assistant", "result"],
  );
});

test("Cursor tool-call failure summary does not fail a successful turn", async () => {
  const cursorBin = script("cursor-tool-failure", [
    emitJson({
      type: "tool_call",
      subtype: "completed",
      call_id: "tool_1",
      session_id: "cursor_session_2",
      tool_call: {
        shellToolCall: {
          result: {
            failure: {
              command: "false",
              exitCode: 1,
            },
          },
        },
      },
    }),
    emitJson({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "NONZERO_HANDLED",
      session_id: "cursor_session_2",
    }),
  ].join("\n"));

  const result = await runCursorTurn({
    prompt: "run false",
    cwd: tempDir,
    cursorBin,
  });

  assert.equal(result.status, "success");
  assert.equal(result.text, "NONZERO_HANDLED");
  assert.deepEqual(result.recentItems[0], {
    type: "tool_call",
    subtype: "completed",
    callId: "tool_1",
    tool: "shellToolCall",
    failed: true,
  });
});

test("Cursor runner reports malformed stream-json", async () => {
  const cursorBin = script("cursor-malformed", "printf '%s\\n' '{nope'");

  const result = await runCursorTurn({
    prompt: "hello",
    cwd: tempDir,
    cursorBin,
  });

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /malformed stream-json/);
});

test("Cursor runner treats interrupted turns without final result as no-publish errors", async () => {
  const cursorBin = script("cursor-sleep", "sleep 60");
  const abortController = new AbortController();
  const pending = runCursorTurn({
    prompt: "sleep",
    cwd: tempDir,
    cursorBin,
    abortController,
  });

  abortController.abort();
  const result = await pending;

  assert.equal(result.status, "error");
  assert.equal(result.text, null);
  assert.match(result.error ?? "", /interrupted/);
});

test("applyCursorStreamEvent records result errors", () => {
  const state: CursorStreamState = {
    sessionId: null,
    resultText: null,
    errorText: null,
    sawFinalResult: false,
    recentItems: [],
  };

  applyCursorStreamEvent(state, {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "Cursor failed",
    session_id: "cursor_session_3",
  });

  assert.equal(state.sessionId, "cursor_session_3");
  assert.equal(state.sawFinalResult, true);
  assert.equal(state.errorText, "Cursor failed");
  assert.equal(state.recentItems.at(-1)?.type, "result");
});

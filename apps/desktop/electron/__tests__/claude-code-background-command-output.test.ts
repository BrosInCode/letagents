import "./isolated-home.js";
import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackgroundCommandOutput,
  claudeBackgroundEndStatus,
  claudeBackgroundOutputPath,
} from "../main/agents/claude-code/background-command-output.js";
import { LIVE_BACKGROUND_COMMAND_METHOD, type LiveBackgroundCommandPayload } from "../../../../shared/live-command-output.mjs";
import { CLAUDE_REAL_CAPTURES, claudeCapturedTask, realClaudeCapture } from "./claude-result-shapes.js";
import { claudeBackgroundHarness, splitAtOwnResult } from "./claude-code-provider-adapter.fixture.js";

async function eventually(condition: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function taskFolder(sessionId: string): Promise<{ root: string; tasks: string }> {
  const root = await mkdtemp(join(tmpdir(), "letagents-background-output-"));
  const tasks = join(root, sessionId, "tasks");
  await mkdir(tasks, { recursive: true });
  return { root, tasks };
}

test("the output file of a background command is accepted only in the CLI's own task folder for the session", () => {
  const path = join("/private/tmp/claude-501/-repo", "session-1", "tasks", "b3esdnfv2.output");
  const text = (where: string) => `Command running in background with ID: b3esdnfv2. Output is being written to: ${where}. You will be notified when it completes.`;
  assert.equal(claudeBackgroundOutputPath(text(path), "b3esdnfv2", "session-1"), path, "a trailing period is not part of the path");
  assert.equal(claudeBackgroundOutputPath(`Output is being written to: ${path} You will be notified`, "b3esdnfv2", "session-1"), path);
  assert.equal(claudeBackgroundOutputPath(text(path), "other-task", "session-1"), null, "the file is named after the structured task id");
  assert.equal(claudeBackgroundOutputPath(text(path), "b3esdnfv2", "other-session"), null, "the file is in the session's own folder");
  assert.equal(claudeBackgroundOutputPath(text("/Users/me/.ssh/b3esdnfv2.output"), "b3esdnfv2", "session-1"), null);
  assert.equal(claudeBackgroundOutputPath(text("session-1/tasks/b3esdnfv2.output"), "b3esdnfv2", "session-1"), null, "a relative path is refused");
  assert.equal(claudeBackgroundOutputPath(text(path), "../escape", "session-1"), null, "a task id is a plain name");
  assert.equal(claudeBackgroundOutputPath("Command finished.", "b3esdnfv2", "session-1"), null);
  const spaced = "C:\\Users\\Ada Lovelace\\AppData\\Local\\Temp\\claude\\repo\\session-1\\tasks\\b3esdnfv2.output";
  if (process.platform === "win32") {
    assert.equal(claudeBackgroundOutputPath(text(spaced), "b3esdnfv2", "session-1"), spaced, "a user folder with a space is a path too");
  }
  const posixSpaced = "/Users/Ada Lovelace/tmp/claude-501/-repo/session-1/tasks/b3esdnfv2.output";
  assert.equal(claudeBackgroundOutputPath(text(posixSpaced), "b3esdnfv2", "session-1"), posixSpaced);
});

test("a follower ends by itself at the CLI's exit line, frees its place, and never sends an event too large to arrive", async () => {
  const { root, tasks } = await taskFolder("session-1");
  const path = join(tasks, "task-1.output");
  const published: LiveBackgroundCommandPayload[] = [];
  let stopped = 0;
  try {
    await writeFile(path, "");
    const follower = new BackgroundCommandOutput({
      taskId: "task-1", toolUseId: null, command: `echo ${"y".repeat(10_000)}`, description: null, path,
      startedAt: "2026-11-08T14:43:00.000Z", now: () => "2026-11-08T14:45:00.000Z",
      publish: (payload) => published.push(payload), onStopped: () => { stopped += 1; }, exitQuietMs: 200,
    });
    follower.start();
    assert.ok(published[0]!.command.length <= 2_000, "the command is bounded");
    // Six thousand characters of a CJK script are three bytes each, and quotes double in JSON.
    await appendFile(path, `${"\"雪\"".repeat(2_000)}\n\n[exited with code 0]\n`);
    await eventually(() => published.at(-1)?.status === "completed", "the exit line ends the follower");
    const last = published.at(-1)!;
    assert.equal(last.exitCode, 0);
    assert.ok(Buffer.byteLength(JSON.stringify(last), "utf8") <= 24 * 1024, "the final event fits the payload limit");
    assert.equal(stopped, 1);
    follower.finish("completed", 0);
    assert.equal(published.at(-1), last, "a later notice changes nothing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an exit line that the command prints itself does not end a command that goes on", async () => {
  const { root, tasks } = await taskFolder("session-1");
  const path = join(tasks, "task-2.output");
  const published: LiveBackgroundCommandPayload[] = [];
  try {
    await writeFile(path, "");
    const follower = new BackgroundCommandOutput({
      taskId: "task-2", toolUseId: null, command: "sh -c 'echo \"[exited with code 0]\"; exec npm run dev'", description: null, path,
      startedAt: "2026-11-09T08:00:00.000Z", now: () => "2026-11-09T08:01:00.000Z",
      publish: (payload) => published.push(payload), exitQuietMs: 400,
    });
    follower.start();
    await appendFile(path, "[exited with code 0]\n");
    await eventually(() => published.some((payload) => payload.output.includes("[exited with code 0]")), "the printed line is shown");
    // The command goes on before the file has been quiet for long enough.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await appendFile(path, "VITE ready in 312 ms\n");
    await eventually(() => published.at(-1)?.output.endsWith("VITE ready in 312 ms\n") === true, "later output is published");
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.ok(published.every((payload) => payload.status === "running"), "the command still runs");
    // The CLI's own exit line at the end of a quiet file does end it.
    await appendFile(path, "\n[exited with code 0]\n");
    await eventually(() => published.at(-1)?.status === "completed", "the real exit line ends the follower");
    assert.match(published.at(-1)!.output, /VITE ready in 312 ms/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a background command's end state comes from Claude Code's status and the command's exit code", () => {
  assert.equal(claudeBackgroundEndStatus("completed", 0), "completed");
  assert.equal(claudeBackgroundEndStatus("completed", 3), "failed");
  assert.equal(claudeBackgroundEndStatus("completed", null), "completed");
  assert.equal(claudeBackgroundEndStatus("failed", null), "failed");
  assert.equal(claudeBackgroundEndStatus("killed", 143), "stopped");
  assert.equal(claudeBackgroundEndStatus("stopped", null), "stopped");
});

test("a follower publishes the newest whole lines of the file, then the end with the exit code", async () => {
  const { root, tasks } = await taskFolder("session-1");
  const path = join(tasks, "task-1.output");
  const published: LiveBackgroundCommandPayload[] = [];
  try {
    await writeFile(path, "\u001b[32mready\u001b[0m in 412 ms\n");
    const follower = new BackgroundCommandOutput({
      taskId: "task-1", toolUseId: "toolu_1", command: "npm run dev", description: "Start the dev server", path,
      startedAt: "2026-11-08T14:43:00.000Z", now: () => "2026-11-08T14:45:00.000Z", publish: (payload) => published.push(payload),
    });
    follower.start();
    assert.deepEqual(published[0], {
      taskId: "task-1", toolUseId: "toolu_1", command: "npm run dev", description: "Start the dev server", status: "running",
      output: "", outputTruncated: false, exitCode: null, startedAt: "2026-11-08T14:43:00.000Z", endedAt: null,
    }, "the running state is published at once");
    await eventually(() => published.at(-1)?.output === "ready in 412 ms\n", "the first line is read");

    await appendFile(path, "GET /api/search 200\nGET /api/mov");
    await eventually(() => published.at(-1)?.output === "ready in 412 ms\nGET /api/search 200\n", "a new whole line is read");
    assert.ok(published.every((payload) => !payload.output.includes("/api/mov")), "a line that is still being written is not shown");

    await appendFile(path, "ie/949 200\n\n[exited with code 3]\n");
    follower.finish("completed", null);
    await eventually(() => published.at(-1)?.status !== "running", "the end is published");
    assert.deepEqual(published.at(-1), {
      taskId: "task-1", toolUseId: "toolu_1", command: "npm run dev", description: "Start the dev server", status: "failed",
      output: "ready in 412 ms\nGET /api/search 200\nGET /api/movie/949 200\n", outputTruncated: false, exitCode: 3,
      startedAt: "2026-11-08T14:43:00.000Z", endedAt: "2026-11-08T14:45:00.000Z",
    });
    const count = published.length;
    await appendFile(path, "late\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(published.length, count, "an ended follower publishes nothing more");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a follower never reads through a symbolic link in the task file's place", { skip: process.platform === "win32" }, async () => {
  const { root, tasks } = await taskFolder("session-1");
  const secret = join(root, "secret.txt");
  const path = join(tasks, "task-1.output");
  const published: LiveBackgroundCommandPayload[] = [];
  try {
    await writeFile(secret, "TOP SECRET\n");
    await symlink(secret, path);
    const follower = new BackgroundCommandOutput({
      taskId: "task-1", toolUseId: null, command: "npm run dev", description: null, path,
      startedAt: "2026-11-08T14:43:00.000Z", now: () => "2026-11-08T14:45:00.000Z", publish: (payload) => published.push(payload),
    });
    follower.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    follower.finish("completed", 0);
    await eventually(() => published.at(-1)?.status === "completed", "the end is published");
    assert.ok(published.every((payload) => !payload.output.includes("TOP SECRET")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Claude agent's background command reaches the owner's live feed with its output, display-only, until it ends", async () => {
  const agent = await claudeBackgroundHarness();
  const { root, tasks } = await taskFolder(agent.sessionId);
  const taskId = claudeCapturedTask("background_command");
  const path = join(tasks, `${taskId}.output`);
  const updates = () => agent.stream.filter((event) => event.method === LIVE_BACKGROUND_COMMAND_METHOD);
  const payloads = () => updates().map((event) => event.payload as LiveBackgroundCommandPayload);
  try {
    await writeFile(path, "Server listening on http://localhost:5173\n");
    const turn = await agent.start("background_command");
    // The capture names the file "/PATH"; this one lives in a real task folder of the session.
    const lines = JSON.parse(JSON.stringify(realClaudeCapture(CLAUDE_REAL_CAPTURES.background_command!, agent.sessionId, turn.turnId).stream)
      .replaceAll("/PATH", JSON.stringify(path).slice(1, -1))) as Array<Record<string, unknown>>;
    const { own, after } = splitAtOwnResult(lines, turn.turnId);
    agent.emit(own);
    await eventually(() => payloads().some((payload) => payload.output === "Server listening on http://localhost:5173\n"), "the first line is published");
    const first = updates()[0]!;
    assert.equal(first.liveDisplayOnly, true, "it is for the owner's live feed only");
    assert.equal(first.kind, "tool_lifecycle");
    assert.deepEqual(
      [payloads()[0]!.taskId, payloads()[0]!.toolUseId, payloads()[0]!.command, payloads()[0]!.status],
      [taskId, "toolu_probe", "sleep 3; echo BACKGROUND_DONE", "running"],
    );

    await appendFile(path, "GET /api/search?q=heat 200\n");
    await eventually(() => payloads().at(-1)?.output.endsWith("GET /api/search?q=heat 200\n") === true, "new output is published");

    await appendFile(path, "\n[exited with code 0]\n");
    agent.emit(after);
    await eventually(() => payloads().at(-1)?.status === "completed", "the end is published");
    assert.equal(payloads().at(-1)!.exitCode, 0);
    assert.doesNotMatch(payloads().at(-1)!.output, /exited with code/, "the CLI's own end line is not repeated");
  } finally {
    await agent.adapter.stop(agent.handle).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("the owner's Stop asks the CLI to stop exactly a followed background command, and reports what the CLI answered", async () => {
  const agent = await claudeBackgroundHarness();
  const { root, tasks } = await taskFolder(agent.sessionId);
  const taskId = claudeCapturedTask("background_command");
  try {
    await writeFile(join(tasks, `${taskId}.output`), "Server listening\n");
    const turn = await agent.start("background_command");
    const lines = JSON.parse(JSON.stringify(realClaudeCapture(CLAUDE_REAL_CAPTURES.background_command!, agent.sessionId, turn.turnId).stream)
      .replaceAll("/PATH", JSON.stringify(join(tasks, `${taskId}.output`)).slice(1, -1))) as Array<Record<string, unknown>>;
    agent.emit(splitAtOwnResult(lines, turn.turnId).own);
    await eventually(() => agent.stream.some((event) => event.method === LIVE_BACKGROUND_COMMAND_METHOD), "the command is followed");

    assert.equal(await agent.adapter.stopBackgroundCommand(agent.handle, "not-a-task"), "not_running", "only a command this adapter follows");
    const before = agent.child.written.length;
    const stopping = agent.adapter.stopBackgroundCommand(agent.handle, taskId);
    await eventually(() => agent.child.written.length > before, "the stop request is written");
    const request = JSON.parse(agent.child.written.at(-1)!) as { type: string; request_id: string; request: { subtype: string; task_id: string } };
    assert.deepEqual([request.type, request.request.subtype, request.request.task_id], ["control_request", "stop_task", taskId]);
    agent.emit([{ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: {} } }]);
    assert.equal(await stopping, "stopping");

    const refused = agent.adapter.stopBackgroundCommand(agent.handle, taskId);
    await eventually(() => agent.child.written.length > before + 1, "a second request is written");
    const second = JSON.parse(agent.child.written.at(-1)!) as { request_id: string };
    agent.emit([{ type: "control_response", response: { subtype: "error", request_id: second.request_id, error: "no such task" } }]);
    assert.equal(await refused, "failed", "a refused stop is reported");
  } finally {
    await agent.adapter.stop(agent.handle).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

import "./isolated-home.js";
import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURSOR_BACKGROUND_OUTPUT,
  CursorBackgroundShells,
  cursorBackgroundShell,
  type CursorBackgroundShellPort,
} from "../main/agents/cursor/background-shells.js";
import type { LiveBackgroundCommandPayload } from "../../../../shared/live-command-output.mjs";

async function eventually(condition: () => boolean, what: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The header Cursor writes first and rewrites in place (cursor-agent 2026.09.18). */
const header = (pid: number, command: string, status = "running  ") => `---\npid: ${pid}\ncwd: "/work"\ncommand: ${JSON.stringify(command)}\n`
  + `title: "Background dev server"\nstatus: ${status}\nstarted_at: 2026-11-09T10:36:35.787Z\nrunning_for_ms: 5005     \n---\n`;
const footer = (exitCode: number) => `\n---\nexit_code: ${exitCode}\nelapsed_ms: 40817\nended_at: 2026-11-09T10:37:16.604Z\n---\n`;

/** The completed event of a shell call that runs in the background, as Cursor sends it. */
function completedCall(terminalsFolder: string, shellId = 22727, pid = 34308) {
  return {
    type: "tool_call", subtype: "completed", call_id: "call-eb0fc3b9-0\nfc_2695_0", session_id: "b6b6502e",
    tool_call: { shellToolCall: {
      args: { command: "npm run dev", isBackground: true, description: "Start the dev server" },
      result: { success: { exitCode: 0, shellId, pid, backgroundReason: "SHELL_BACKGROUND_REASON_USER_REQUEST" }, isBackground: true, terminalsFolder },
    } },
  };
}

async function terminals(): Promise<{ root: string; folder: string }> {
  const root = await mkdtemp(join(tmpdir(), "letagents-cursor-shells-"));
  const folder = join(root, "projects", "private-tmp-work", "terminals");
  await mkdir(folder, { recursive: true });
  return { root, folder };
}

function port(overrides: Partial<CursorBackgroundShellPort<string>> = {}) {
  const published: LiveBackgroundCommandPayload[] = [];
  const turns: string[] = [];
  const signals: Array<[number, string, string]> = [];
  const value: CursorBackgroundShellPort<string> = {
    now: () => "2026-11-09T10:36:36.000Z",
    publish: (payload, turn) => { published.push(payload); turns.push(turn); },
    processIdentity: () => "Mon Nov  9 10:36:35 2026",
    signalExact: (pid, identity, signal) => { signals.push([pid, identity, signal]); return "signalled"; },
    ...overrides,
  };
  return { value, published, turns, signals };
}

test("Cursor's file format: the header and footer are not output, and the footer holds the exit code", () => {
  const running = `${header(11203, "for i in $(seq 1 40); do echo tick $i; sleep 1; done")}tick 1\ntick 2\n`;
  assert.equal(CURSOR_BACKGROUND_OUTPUT.body(running, false), "tick 1\ntick 2\n");
  assert.equal(CURSOR_BACKGROUND_OUTPUT.exitCode(running), null);
  const ended = `${running}tick 3\n${footer(0)}`;
  assert.equal(CURSOR_BACKGROUND_OUTPUT.body(ended, true), "tick 1\ntick 2\ntick 3\n");
  assert.equal(CURSOR_BACKGROUND_OUTPUT.exitCode(ended), 0);
  assert.equal(CURSOR_BACKGROUND_OUTPUT.body("---\npid: 1\ncwd: \"/w", false), "", "a header still being written holds no output");
  assert.equal(CURSOR_BACKGROUND_OUTPUT.body("tick 9\ntick 10\n", false), "tick 9\ntick 10\n", "text from the middle of the file is all output");
});

test("a shell call is followed only when it runs in the background, in Cursor's own terminals folder", () => {
  const shell = cursorBackgroundShell(completedCall("/data/projects/ws/terminals"));
  assert.deepEqual(shell, { shellId: "22727", pid: 34308, command: "npm run dev", description: "Start the dev server",
    path: join("/data/projects/ws/terminals", "22727.txt"), callId: "call-eb0fc3b9-0\nfc_2695_0" });
  const foreground = completedCall("/data/projects/ws/terminals");
  foreground.tool_call.shellToolCall.result.isBackground = false;
  assert.equal(cursorBackgroundShell(foreground), null);
  for (const folder of ["relative/projects/ws/terminals", "/data/projects/ws/other", "/data/elsewhere/ws/terminals"]) {
    assert.equal(cursorBackgroundShell(completedCall(folder)), null, folder);
  }
  assert.equal(cursorBackgroundShell(completedCall("/data/projects/ws/terminals", -1)), null, "no negative shell id");
  assert.equal(cursorBackgroundShell(completedCall("/data/projects/ws/terminals", 1, 1)), null, "no pid 1");
});

test("a Cursor background shell shows its output, ends at Cursor's notice, and Stop signals its exact process group", async () => {
  const { root, folder } = await terminals();
  const shells = port();
  try {
    const followed = new CursorBackgroundShells(shells.value, 200);
    await writeFile(join(folder, "22727.txt"), `${header(34308, "npm run dev")}VITE ready\n`);
    followed.follow(completedCall(folder), "turn-1");
    await eventually(() => shells.published.at(-1)?.output === "VITE ready\n", "the output after the header is shown");
    assert.deepEqual([shells.published[0]!.taskId, shells.published[0]!.toolUseId, shells.published[0]!.command, shells.published[0]!.status],
      ["22727", "call-eb0fc3b9-0\nfc_2695_0", "npm run dev", "running"]);

    // Stop: SIGTERM to the shell's process group, with the identity read when the call reported the shell.
    assert.equal(followed.stop("22727"), "stopping");
    assert.deepEqual(shells.signals, [[34308, "Mon Nov  9 10:36:35 2026", "SIGTERM"]]);
    await appendFile(join(folder, "22727.txt"), footer(143));
    followed.noticeEnded({ type: "system", subtype: "task_notification", task_id: "22727", status: "error" });
    await eventually(() => shells.published.at(-1)?.status === "stopped", "a stopped shell reads as stopped");
    assert.deepEqual([shells.published.at(-1)!.exitCode, shells.published.at(-1)!.output], [143, "VITE ready\n"]);
    assert.equal(followed.stop("22727"), "not_running", "an ended shell is no longer followed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("when the turn's CLI process exits, each of its shells ends: by its footer, with the turn, or as stopped", async () => {
  const { root, folder } = await terminals();
  const shells = port();
  try {
    const followed = new CursorBackgroundShells(shells.value, 200);
    await writeFile(join(folder, "1.txt"), `${header(5001, "sleep 40")}`);
    await writeFile(join(folder, "2.txt"), `${header(5002, "npm test")}ok\n${footer(0)}`);
    await writeFile(join(folder, "3.txt"), `${header(5003, "npm run dev")}ready\n`);
    await writeFile(join(folder, "4.txt"), `${header(5004, "npm run watch")}watching\n`);
    followed.follow(completedCall(folder, 1, 5001), "turn-1");
    followed.follow(completedCall(folder, 2, 5002), "turn-1");
    followed.follow(completedCall(folder, 3, 5003), "turn-1");
    followed.follow(completedCall(folder, 4, 5004), "turn-2");
    await eventually(() => new Set(shells.published.map((payload) => payload.taskId)).size === 4, "all shells are shown");
    assert.equal(followed.stop("3"), "stopping");

    followed.turnEnded("turn-1");
    const final = (taskId: string) => shells.published.filter((payload) => payload.taskId === taskId).at(-1)?.status;
    // The quiet shell ends with the turn, the one with Cursor's footer by itself, the stopped one as stopped.
    await eventually(() => ["1", "2", "3"].every((taskId) => final(taskId) !== "running"), "the turn's shells end").catch(() => undefined);
    assert.deepEqual(["1", "2", "3"].map(final), ["lost", "completed", "stopped"]);
    assert.equal(final("4"), "running", "a shell of another turn runs on");
    assert.equal(followed.stop("1"), "not_running", "an ended shell is no longer followed");
    // Each value names the turn whose CLI process started its shell.
    assert.deepEqual([...new Set(shells.published.flatMap((payload, index) => payload.taskId === "4" ? [shells.turns[index]] : []))], ["turn-2"]);
    followed.closeAll();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the owner's Stop wins: a stopped server that exits cleanly, or whose notice comes late, reads as stopped", async () => {
  const { root, folder } = await terminals();
  const shells = port();
  try {
    const followed = new CursorBackgroundShells(shells.value, 150);
    await writeFile(join(folder, "5.txt"), `${header(5005, "npm run dev")}ready\n`);
    await writeFile(join(folder, "6.txt"), `${header(5006, "npm run preview")}ready\n`);
    followed.follow(completedCall(folder, 5, 5005), "turn-1");
    followed.follow(completedCall(folder, 6, 5006), "turn-1");
    await eventually(() => shells.published.length >= 2, "both shells are shown");

    // A server that handles SIGTERM and exits 0: Cursor says success.
    assert.equal(followed.stop("5"), "stopping");
    await appendFile(join(folder, "5.txt"), footer(0));
    followed.noticeEnded({ type: "system", subtype: "task_notification", task_id: "5", status: "success" });
    await eventually(() => shells.published.some((payload) => payload.taskId === "5" && payload.status === "stopped"), "a clean exit after Stop reads as stopped");

    // The footer arrives, but the notice does not: the end the footer shows is stopped, not failed (143).
    assert.equal(followed.stop("6"), "stopping");
    await appendFile(join(folder, "6.txt"), footer(143));
    await eventually(() => shells.published.some((payload) => payload.taskId === "6" && payload.status !== "running"), "the footer ends it");
    assert.deepEqual(shells.published.filter((payload) => payload.taskId === "6" && payload.status !== "running").map((payload) => payload.status), ["stopped"]);
    followed.closeAll();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stop is refused without the shell's process identity, and answers not running for a gone process", async () => {
  const { root, folder } = await terminals();
  try {
    const unknown = port({ processIdentity: () => undefined });
    const noIdentity = new CursorBackgroundShells(unknown.value, 200);
    await writeFile(join(folder, "7.txt"), header(7007, "npm run dev"));
    noIdentity.follow(completedCall(folder, 7, 7007), "turn-1");
    assert.equal(noIdentity.stop("7"), "failed");
    assert.deepEqual(unknown.signals, [], "nothing is signalled");
    noIdentity.closeAll();

    const gone = port({ signalExact: () => "absent" });
    const goneShells = new CursorBackgroundShells(gone.value, 200);
    goneShells.follow(completedCall(folder, 7, 7007), "turn-1");
    assert.equal(goneShells.stop("7"), "not_running");
    goneShells.closeAll();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

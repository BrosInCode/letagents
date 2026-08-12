import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

import { requireSupportedClaudeCodeVersion } from "../main/agents/claude-code-version.js";
import {
  exactClaudeCommandLifecycleState,
  exactClaudeStreamTerminal,
  recoverExactClaudeTurnFromSession,
  type ClaudeEvidenceRecord,
  type ClaudeExactTurnResult,
} from "../main/agents/claude-room-turn-evidence.js";

const LIVE_SPIKE_ENV = "LETAGENTS_RUN_LIVE_CLAUDE_SPIKE";
const TURN_TIMEOUT_MS = 60_000;
const PROCESS_EXIT_TIMEOUT_MS = 10_000;
const claudeBin = process.env.LETAGENTS_CLAUDE_CODE_BIN
  || process.env.LETAGENTS_CLAUDE_BIN
  || "claude";
const model = process.env.LETAGENTS_CLAUDE_SPIKE_MODEL || "haiku";

async function main(): Promise<void> {
  if (process.env[LIVE_SPIKE_ENV] !== "1") {
    throw new Error(
      `This smoke test makes real Claude API calls. Set ${LIVE_SPIKE_ENV}=1 to run it deliberately.`,
    );
  }

  const versionOutput = await execClaude(["--version"]);
  const version = requireSupportedClaudeCodeVersion(versionOutput);
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "letagents-claude-daemon-spike-")),
  );
  const sessionId = randomUUID();
  const bootstrapTurnId = randomUUID();
  const boundedTurnId = randomUUID();
  const resumeTurnId = randomUUID();
  let first: ClaudeStreamProcess | null = null;
  let resumed: ClaudeStreamProcess | null = null;
  let sessionFile: string | null = null;
  let succeeded = false;

  try {
    first = launchClaude(sessionId, workspace, false);
    const bootstrap = await first.runTurn(
      bootstrapTurnId,
      "Initialize this headless session. Reply exactly CLAUDE_DAEMON_BOOTSTRAP_READY. Do not call tools.",
    );
    assertReply(bootstrap, "CLAUDE_DAEMON_BOOTSTRAP_READY", "bootstrap");
    first.assertInitializedSession(sessionId);

    const bounded = await first.runTurn(
      boundedTurnId,
      "SPIKE_INBOX_ITEM. Reply exactly CLAUDE_DAEMON_BOUNDED_TURN_OK. Do not call tools.",
    );
    assertReply(bounded, "CLAUDE_DAEMON_BOUNDED_TURN_OK", "bounded turn");

    // Simulate provider-child death after Claude attests native completion but
    // before the supervisor durably checkpoints it. Recovery below may read
    // evidence only; it must not send the bounded prompt a second time.
    const killed = await first.kill("SIGKILL");
    if (killed.signal !== "SIGKILL") {
      throw new Error(`Expected the first Claude process to exit via SIGKILL, got ${killed.signal ?? killed.code}.`);
    }

    sessionFile = await waitForSessionFile(sessionId);
    const rows = await waitForPersistedTurn(sessionFile, boundedTurnId);
    const recovered = recoverExactClaudeTurnFromSession(rows, boundedTurnId, sessionId);
    const matchingUserRows = rows.filter((row) =>
      row.type === "user" && row.uuid === boundedTurnId
    );
    if (matchingUserRows.length !== 1) {
      throw new Error(`Expected one persisted bounded command, found ${matchingUserRows.length}.`);
    }

    resumed = launchClaude(sessionId, workspace, true);
    const resumedResult = await resumed.runTurn(
      resumeTurnId,
      "Resume the same session. Reply exactly CLAUDE_DAEMON_RESUME_OK. Do not call tools.",
    );
    assertReply(resumedResult, "CLAUDE_DAEMON_RESUME_OK", "resume");
    resumed.assertInitializedSession(sessionId);
    await resumed.close();

    console.log(JSON.stringify({
      ok: true,
      claude_version: version,
      model,
      exact_input_uuid_acknowledged: true,
      exact_result_user_message_uuid: true,
      completed_lifecycle_correlated: true,
      graceful_exit_terminal_boundary: "assistant.message.stop_reason=end_turn",
      crash_after_completed_signal_recovery:
        recovered?.outcome === "reply" ? "available" : "missing_terminal_boundary",
      resumed_same_session_id: true,
      bounded_turn_user_rows: matchingUserRows.length,
      exact_turn_contract_ready: true,
      production_recovery_policy: "graceful_orphan_drain_then_exact_transcript_or_fail_closed",
    }, null, 2));
    succeeded = true;
  } finally {
    await first?.close().catch(() => undefined);
    await resumed?.close().catch(() => undefined);
    if (!sessionFile) {
      sessionFile = await findSessionFile(sessionId).catch(() => null);
    }
    if (succeeded) {
      if (sessionFile && basename(sessionFile) === `${sessionId}.jsonl`) {
        await rm(sessionFile, { force: true });
      }
      await rm(workspace, { recursive: true, force: true });
    } else {
      console.error(JSON.stringify({
        forensic_artifacts_preserved: {
          workspace,
          session_file: sessionFile,
        },
      }, null, 2));
    }
  }
}

type ProcessExit = { code: number | null; signal: NodeJS.Signals | null };

class ClaudeStreamProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly events: ClaudeEvidenceRecord[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly exitPromise: Promise<ProcessExit>;
  private stderr = "";
  private closed = false;

  constructor(
    private readonly expectedSessionId: string,
    cwd: string,
    resume: boolean,
  ) {
    const args = [
      "--print",
      "--verbose",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--replay-user-messages",
      "--strict-mcp-config",
      "--mcp-config", "{\"mcpServers\":{}}",
      "--permission-mode", "dontAsk",
      "--model", model,
      "--max-budget-usd", "0.50",
      ...(resume ? ["--resume", expectedSessionId] : ["--session-id", expectedSessionId]),
    ];
    const env = { ...process.env };
    delete env.CLAUDECODE;
    this.child = spawn(claudeBin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.exitPromise = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-4_000);
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line) as ClaudeEvidenceRecord;
        this.events.push(event);
        for (const listener of this.listeners) listener();
      } catch {
        // Non-JSON output cannot prove an exact turn boundary.
      }
    });
  }

  async runTurn(
    turnId: string,
    prompt: string,
    options: { waitForCompletedLifecycle?: boolean } = {},
  ): Promise<ClaudeExactTurnResult> {
    const startIndex = this.events.length;
    this.child.stdin.write(`${JSON.stringify({
      type: "user",
      uuid: turnId,
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    })}\n`);
    const terminalEvent = await this.waitFor(
      (event) => exactClaudeStreamTerminal(event, turnId, this.expectedSessionId) !== null,
      startIndex,
      TURN_TIMEOUT_MS,
    );
    const terminal = exactClaudeStreamTerminal(terminalEvent, turnId, this.expectedSessionId);
    if (!terminal || "error" in terminal) {
      throw new Error(terminal && "error" in terminal ? terminal.error : "Claude returned no exact terminal result.");
    }
    if (options.waitForCompletedLifecycle !== false) {
      await this.waitFor(
        (event) =>
          exactClaudeCommandLifecycleState(event, turnId, this.expectedSessionId) === "completed",
        startIndex,
        TURN_TIMEOUT_MS,
      );
    }
    return terminal;
  }

  assertInitializedSession(sessionId: string): void {
    const init = this.events.find((event) => event.type === "system" && event.subtype === "init");
    if (!init || init.session_id !== sessionId) {
      throw new Error("Claude init did not attest the requested session id.");
    }
  }

  async kill(signal: NodeJS.Signals): Promise<ProcessExit> {
    if (!this.closed) {
      this.closed = true;
      this.child.kill(signal);
    }
    return this.withExitTimeout();
  }

  async close(): Promise<ProcessExit> {
    if (!this.closed) {
      this.closed = true;
      this.child.stdin.end();
    }
    return this.withExitTimeout();
  }

  private async withExitTimeout(): Promise<ProcessExit> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        this.exitPromise,
        new Promise<ProcessExit>((_, reject) => {
          timer = setTimeout(() => {
            this.child.kill("SIGKILL");
            reject(new Error(`Claude process did not exit. ${this.stderr}`.trim()));
          }, PROCESS_EXIT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private waitFor(
    predicate: (event: ClaudeEvidenceRecord) => boolean,
    startIndex: number,
    timeoutMs: number,
  ): Promise<ClaudeEvidenceRecord> {
    const existing = this.events.slice(startIndex).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      let check: () => void;
      const timeout = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`Timed out waiting for exact Claude evidence. ${this.stderr}`.trim()));
      }, timeoutMs);
      check = () => {
        const match = this.events.slice(startIndex).find(predicate);
        if (!match) return;
        clearTimeout(timeout);
        this.listeners.delete(check);
        resolve(match);
      };
      this.listeners.add(check);
    });
  }
}

function launchClaude(sessionId: string, cwd: string, resume: boolean): ClaudeStreamProcess {
  return new ClaudeStreamProcess(sessionId, cwd, resume);
}

function assertReply(
  result: ClaudeExactTurnResult | null,
  expected: string,
  label: string,
): void {
  if (result?.outcome !== "reply" || result.text !== expected) {
    throw new Error(`${label} returned ${JSON.stringify(result)} instead of ${expected}.`);
  }
}

async function execClaude(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(claudeBin, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Claude CLI check failed: ${error.message}`));
        return;
      }
      resolve(String(stdout || stderr || ""));
    });
  });
}

async function waitForSessionFile(sessionId: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const path = await findSessionFile(sessionId);
    if (path) return path;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Claude did not persist the exact spike session JSONL.");
}

async function findSessionFile(sessionId: string): Promise<string | null> {
  const root = join(homedir(), ".claude", "projects");
  const target = `${sessionId}.jsonl`;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name === target) return path;
    }
  }
  return null;
}

async function readSessionRows(path: string): Promise<ClaudeEvidenceRecord[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ClaudeEvidenceRecord);
}

async function waitForPersistedTurn(
  path: string,
  turnId: string,
): Promise<ClaudeEvidenceRecord[]> {
  const deadline = Date.now() + 10_000;
  let rows: ClaudeEvidenceRecord[] = [];
  while (Date.now() < deadline) {
    rows = await readSessionRows(path);
    if (rows.some((row) => row.type === "user" && row.uuid === turnId)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Claude session JSONL did not persist the exact bounded command.");
}

await main();

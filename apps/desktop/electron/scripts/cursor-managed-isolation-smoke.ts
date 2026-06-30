import { execFile, execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { prepareCursorManagedProfile } from "../main/agents/cursor-managed-profile.js";
import { buildCursorAgentArgs, buildCursorChildEnv } from "../main/agents/cursor-runner.js";

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
};

type CursorSmokeTurnResult = {
  status: "success" | "error";
  text: string | null;
  error: string | null;
  rawEvents: Array<Record<string, unknown>>;
};

const cursorBin = process.env.LETAGENTS_CURSOR_AGENT_BIN || "cursor-agent";
const workspaceRoot = resolveWorkspaceRoot();
const profile = prepareCursorManagedProfile({ workspaceRoot });
const env = buildCursorChildEnv(profile.env);

console.log(`workspace: ${workspaceRoot}`);
console.log(`managed HOME: ${profile.homeDir}`);

const status = await execCursor(["status"]);
assertOk(status, "cursor-agent status");
console.log(`status: ${firstLine(status)}`);

const mcpList = await execCursor(["mcp", "list"]);
assertOk(mcpList, "cursor-agent mcp list");
assertDoesNotMentionLetAgents(mcpList, "cursor-agent mcp list");
console.log(`mcp list: ${firstLine(mcpList) || "<empty>"}`);

const listTools = await execCursor(["mcp", "list-tools", "letagents"]);
if (listTools.ok) {
  throw new Error("cursor-agent mcp list-tools letagents unexpectedly succeeded.");
}
console.log(`mcp list-tools letagents: ${firstLine(listTools) || `exit ${listTools.code ?? "unknown"}`}`);

const normalTurn = await runCursorSmokeTurn("Reply exactly MANAGED_CURSOR_READONLY_OK. Do not call tools.");
if (normalTurn.status !== "success" || normalTurn.text?.trim() !== "MANAGED_CURSOR_READONLY_OK") {
  throw new Error(
    `managed Cursor read-only turn failed: ${normalTurn.error || normalTurn.text || "missing result"}`,
  );
}
console.log("read-only turn: MANAGED_CURSOR_READONLY_OK");

const isolationTurn = await runCursorSmokeTurn(
  [
    "Try to list or call LetAgents MCP tools, especially get_current_room.",
    "If no LetAgents MCP tools are available, reply exactly LETAGENTS_MCP_UNAVAILABLE.",
    "Do not call unrelated tools.",
  ].join(" "),
);
if (isolationTurn.status !== "success" || isolationTurn.text?.trim() !== "LETAGENTS_MCP_UNAVAILABLE") {
  throw new Error(
    `managed Cursor isolation turn failed: ${isolationTurn.error || isolationTurn.text || "missing result"}`,
  );
}
const letAgentsToolCall = isolationTurn.rawEvents.find((event) =>
  event.type === "tool_call" &&
  JSON.stringify(event).toLowerCase().includes("letagents")
);
if (letAgentsToolCall) {
  throw new Error("managed Cursor isolation turn emitted a LetAgents-looking tool call.");
}
console.log("isolation turn: LETAGENTS_MCP_UNAVAILABLE");
console.log("Cursor managed isolation smoke passed.");

function resolveWorkspaceRoot(): string {
  const index = process.argv.indexOf("--workspace");
  if (index >= 0 && process.argv[index + 1]) {
    return resolve(process.argv[index + 1]);
  }

  const gitRoot = execFileSyncOrNull("git", ["rev-parse", "--show-toplevel"], process.cwd());
  return gitRoot ? resolve(gitRoot.trim()) : resolve(process.cwd());
}

function execCursor(args: string[]): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    execFile(
      cursorBin,
      args,
      {
        cwd: workspaceRoot,
        env,
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        const nodeError = error as NodeJS.ErrnoException & { code?: string | number | null } | null;
        resolveResult({
          ok: !error,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          code: typeof nodeError?.code === "number" ? nodeError.code : null,
        });
      },
    );
  });
}

function runCursorSmokeTurn(prompt: string): Promise<CursorSmokeTurnResult> {
  const rawEvents: Array<Record<string, unknown>> = [];
  let stderr = "";
  let parseError: string | null = null;
  let resultText: string | null = null;
  let errorText: string | null = null;
  let sawFinalResult = false;

  return new Promise((resolveResult) => {
    const child = spawn(
      cursorBin,
      buildCursorAgentArgs({
        cwd: workspaceRoot,
        env: profile.env,
        mode: "ask",
        prompt,
      }),
      {
        cwd: workspaceRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        rawEvents.push(event);
        if (event.type === "result") {
          sawFinalResult = true;
          if (event.subtype === "success" && event.is_error !== true) {
            resultText = typeof event.result === "string" ? event.result : null;
            return;
          }
          errorText = typeof event.result === "string" && event.result.trim()
            ? event.result
            : `Cursor result subtype was ${String(event.subtype ?? "unknown")}.`;
        }
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
    });

    child.on("error", (error) => {
      resolveResult({
        status: "error",
        text: null,
        error: error.message,
        rawEvents,
      });
    });

    child.on("close", (code) => {
      if (parseError) {
        resolveResult({
          status: "error",
          text: null,
          error: `Cursor emitted malformed stream-json: ${parseError}`,
          rawEvents,
        });
        return;
      }
      if (errorText) {
        resolveResult({
          status: "error",
          text: null,
          error: errorText,
          rawEvents,
        });
        return;
      }
      if (sawFinalResult) {
        resolveResult({
          status: "success",
          text: resultText,
          error: null,
          rawEvents,
        });
        return;
      }
      resolveResult({
        status: "error",
        text: null,
        error: firstNonEmptyLine(stderr) || `Cursor exited without a final result (code ${code ?? "unknown"}).`,
        rawEvents,
      });
    });
  });
}

function execFileSyncOrNull(command: string, args: string[], cwd: string): string | null {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf-8" });
  } catch {
    return null;
  }
}

function assertOk(result: CommandResult, label: string): void {
  if (result.ok) {
    return;
  }
  throw new Error(`${label} failed: ${firstLine(result) || `exit ${result.code ?? "unknown"}`}`);
}

function assertDoesNotMentionLetAgents(result: CommandResult, label: string): void {
  if (`${result.stdout}\n${result.stderr}`.toLowerCase().includes("letagents")) {
    throw new Error(`${label} unexpectedly mentioned LetAgents.`);
  }
}

function firstNonEmptyLine(value: string): string | null {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

function firstLine(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import type {
  DesktopCursorMcpPolicy,
  DesktopManagedAgentPermissionProfileId,
} from "../ipc-types.js";
import {
  normalizeCursorMcpPolicy,
  prepareCursorManagedProfile,
} from "../main/agents/cursor-managed-profile.js";
import { cursorLaunchOptionsForPermissionProfile } from "../main/agents/cursor-permission-profile.js";
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
const mcpPolicy = resolveMcpPolicy();
const permissionProfile = resolvePermissionProfile();
const launchOptions = cursorLaunchOptionsForPermissionProfile(permissionProfile);
const profile = prepareCursorManagedProfile({ workspaceRoot, mcpPolicy });
const env = buildCursorChildEnv(profile.env);

console.log(`workspace: ${workspaceRoot}`);
console.log(`cursor HOME: ${profile.homeDir}`);
console.log(`mcp policy: ${mcpPolicy}`);
console.log(`permission profile: ${permissionProfile}`);

const status = await execCursor(["status"]);
assertOk(status, "cursor-agent status");
console.log(`status: ${firstLine(status)}`);

const mcpList = await execCursor(["mcp", "list"]);
assertOk(mcpList, "cursor-agent mcp list");
if (mcpPolicy === "normal") {
  if (mentionsLetAgents(mcpList)) {
    console.log("mcp list warning: normal policy exposes a LetAgents-looking MCP server.");
  }
} else {
  assertDoesNotMentionLetAgents(mcpList, "cursor-agent mcp list");
  if (mcpPolicy === "none") {
    assertMcpListLooksEmpty(mcpList);
  }
}
console.log(`mcp list: ${firstLine(mcpList) || "<empty>"}`);

if (mcpPolicy !== "normal") {
  const listTools = await execCursor(["mcp", "list-tools", "letagents"]);
  if (listTools.ok) {
    throw new Error("cursor-agent mcp list-tools letagents unexpectedly succeeded.");
  }
  console.log(`mcp list-tools letagents: ${firstLine(listTools) || `exit ${listTools.code ?? "unknown"}`}`);
} else {
  console.log("mcp list-tools letagents: skipped for normal policy.");
}

const normalTurn = await runCursorSmokeTurn("Reply exactly MANAGED_CURSOR_READONLY_OK. Do not call tools.");
if (normalTurn.status !== "success" || normalTurn.text?.trim() !== "MANAGED_CURSOR_READONLY_OK") {
  throw new Error(
    `managed Cursor read-only turn failed: ${normalTurn.error || normalTurn.text || "missing result"}`,
  );
}
console.log("read-only turn: MANAGED_CURSOR_READONLY_OK");

if (permissionProfile === "sandboxed_write" || permissionProfile === "full_access") {
  const writeSmokeFile = join(workspaceRoot, ".letagents", "cursor-managed-write-smoke.txt");
  rmSync(writeSmokeFile, { force: true });
  mkdirSync(dirname(writeSmokeFile), { recursive: true });
  const writeTurn = await runCursorSmokeTurn(
    [
      `Create or overwrite ${JSON.stringify(writeSmokeFile)} with exactly MANAGED_CURSOR_WRITE_OK.`,
      "Then reply exactly MANAGED_CURSOR_WRITE_OK.",
    ].join(" "),
  );
  try {
    if (writeTurn.status !== "success" || !writeTurn.text?.includes("MANAGED_CURSOR_WRITE_OK")) {
      throw new Error(
        `managed Cursor write turn failed: ${writeTurn.error || writeTurn.text || "missing result"}`,
      );
    }
    if (!existsSync(writeSmokeFile) || readFileSync(writeSmokeFile, "utf-8").trim() !== "MANAGED_CURSOR_WRITE_OK") {
      throw new Error("managed Cursor write turn did not create the expected smoke file.");
    }
    console.log("write turn: MANAGED_CURSOR_WRITE_OK");
  } finally {
    rmSync(writeSmokeFile, { force: true });
  }
}

if (mcpPolicy !== "normal") {
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
} else {
  console.log("isolation turn: skipped for normal policy.");
}
console.log("Cursor managed isolation smoke passed.");

function resolveMcpPolicy(): DesktopCursorMcpPolicy {
  const value = valueForFlag("--mcp-policy") ?? valueForFlag("--cursor-mcp-policy");
  if (value && value !== "filter_letagents" && value !== "normal" && value !== "none") {
    throw new Error(`Unsupported Cursor MCP policy '${value}'. Use filter_letagents, normal, or none.`);
  }
  return normalizeCursorMcpPolicy(value);
}

function resolvePermissionProfile(): DesktopManagedAgentPermissionProfileId {
  const value = valueForFlag("--permission-profile") ?? valueForFlag("--cursor-permission-profile");
  if (value && value !== "read_only" && value !== "sandboxed_write" && value !== "full_access") {
    throw new Error(`Unsupported Cursor permission profile '${value}'. Use read_only, sandboxed_write, or full_access.`);
  }
  return (value || "read_only") as DesktopManagedAgentPermissionProfileId;
}

function resolveWorkspaceRoot(): string {
  const index = process.argv.indexOf("--workspace");
  if (index >= 0 && process.argv[index + 1]) {
    return resolve(process.argv[index + 1]);
  }

  const gitRoot = execFileSyncOrNull("git", ["rev-parse", "--show-toplevel"], process.cwd());
  return gitRoot ? resolve(gitRoot.trim()) : resolve(process.cwd());
}

function valueForFlag(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1] ?? null;
  }
  const prefix = `${flag}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : null;
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
        mode: launchOptions.mode,
        force: launchOptions.force,
        sandbox: launchOptions.sandbox,
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
  if (mentionsLetAgents(result)) {
    throw new Error(`${label} unexpectedly mentioned LetAgents.`);
  }
}

function assertMcpListLooksEmpty(result: CommandResult): void {
  const output = `${result.stdout}\n${result.stderr}`.trim().toLowerCase();
  if (!output || output === "[]" || output.includes("no mcp") || output.includes("no servers")) {
    return;
  }
  throw new Error(`cursor-agent mcp list unexpectedly showed MCP servers for none policy: ${output}`);
}

function mentionsLetAgents(result: CommandResult): boolean {
  return `${result.stdout}\n${result.stderr}`.toLowerCase().includes("letagents");
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

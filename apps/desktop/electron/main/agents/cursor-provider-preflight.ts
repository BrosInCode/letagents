import { execFile } from "node:child_process";
import { resolve } from "node:path";

import type {
  DesktopAgentProvider,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderPreflightInput,
  DesktopMcpInstallTarget,
} from "../../ipc-types.js";
import { normalizeCursorMcpPolicy, prepareCursorManagedProfile } from "./cursor-managed-profile.js";
import { buildCursorChildEnv } from "./cursor-runner.js";

type ExecResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  errorCode: string | null;
};

type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

const COMMAND_TIMEOUT_MS = 8_000;

export async function runDesktopCursorProviderPreflight(
  provider: DesktopAgentProvider,
  input: DesktopAgentProviderPreflightInput,
  mcpStatus: DesktopMcpInstallTarget["status"] | null,
): Promise<DesktopAgentProviderPreflight> {
  const command = process.env.LETAGENTS_CURSOR_AGENT_BIN ||
    provider.runtimeCommand ||
    "cursor-agent";
  const versionResult = await execFileWithTimeout(command, ["--version"]);
  if (commandMissing(versionResult)) {
    return {
      providerId: provider.id,
      status: "missing_runtime",
      canStart: false,
      message: "Cursor Agent is not installed.",
      detail: "Install Cursor Agent before starting a local read-only Cursor room agent.",
      nextAction: null,
      version: null,
      mcpStatus,
    };
  }
  if (!versionResult.ok) {
    return {
      providerId: provider.id,
      status: "error",
      canStart: false,
      message: "Cursor Agent could not be checked.",
      detail: firstOutputLine(versionResult) || "The Cursor Agent command failed before returning a version.",
      nextAction: null,
      version: null,
      mcpStatus,
    };
  }

  const version = firstOutputLine(versionResult);
  const workspaceRoot = input.repoRootPath?.trim() ? resolve(input.repoRootPath.trim()) : null;
  const cursorMcpPolicy = normalizeCursorMcpPolicy(input.cursorMcpPolicy);
  let managedProfile;
  try {
    managedProfile = prepareCursorManagedProfile({
      workspaceRoot,
      mcpPolicy: cursorMcpPolicy,
    });
  } catch (error) {
    return {
      providerId: provider.id,
      status: "error",
      canStart: false,
      message: "Cursor managed profile could not be prepared.",
      detail: error instanceof Error ? error.message : String(error),
      nextAction: null,
      version,
      mcpStatus,
    };
  }
  const managedEnv = buildCursorChildEnv(managedProfile.env);
  const authResult = await execFileWithTimeout(command, ["status"], { env: managedEnv });
  if (!authResult.ok) {
    return {
      providerId: provider.id,
      status: "auth_required",
      canStart: false,
      message: "Cursor Agent needs sign-in.",
      detail: firstOutputLine(authResult) || "Sign in with Cursor Agent before starting a local room agent.",
      nextAction: "authenticate",
      version,
      mcpStatus,
    };
  }

  if (!workspaceRoot) {
    return {
      providerId: provider.id,
      status: "repo_required",
      canStart: false,
      message: "Choose a local repository before starting Cursor.",
      detail: "A desktop-managed Cursor agent needs a local repo or worktree for read-only analysis.",
      nextAction: "choose_repo",
      version,
      mcpStatus,
    };
  }

  if (cursorMcpPolicy !== "normal") {
    const mcpResult = await execFileWithTimeout(command, ["mcp", "list"], {
      cwd: workspaceRoot,
      env: managedEnv,
    });
    if (!mcpResult.ok) {
      return {
        providerId: provider.id,
        status: "error",
        canStart: false,
        message: "Cursor managed MCP policy could not be checked.",
        detail: firstOutputLine(mcpResult) || "Cursor failed while listing MCP servers under the selected managed profile.",
        nextAction: null,
        version,
        mcpStatus,
      };
    }
    if (mentionsLetAgentsMcp(mcpResult)) {
      return {
        providerId: provider.id,
        status: "error",
        canStart: false,
        message: "Cursor can still see LetAgents MCP.",
        detail: "Managed Cursor must not expose LetAgents room tools under the selected MCP policy. Remove project-level LetAgents MCP config or repair the managed profile.",
        nextAction: null,
        version,
        mcpStatus,
      };
    }
  }

  return {
    providerId: provider.id,
    status: "ready",
    canStart: true,
    message: "Cursor Agent is ready to start in read-only mode.",
    detail: cursorPreflightReadyDetail(cursorMcpPolicy, mcpStatus),
    nextAction: null,
    version,
    mcpStatus,
  };
}

function execFileWithTimeout(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolveResult) => {
    const child = execFile(
      command,
      args,
      {
        timeout: COMMAND_TIMEOUT_MS,
        cwd: options.cwd,
        env: options.env,
      },
      (error, stdout, stderr) => {
        const nodeError = error as NodeJS.ErrnoException | null;
        resolveResult({
          ok: !error,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          errorCode: nodeError?.code ? String(nodeError.code) : null,
        });
      },
    );
    child.stdin?.end();
  });
}

function commandMissing(result: ExecResult): boolean {
  return result.errorCode === "ENOENT";
}

function firstOutputLine(result: ExecResult): string | null {
  const line = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line || null;
}

function mentionsLetAgentsMcp(result: ExecResult): boolean {
  return `${result.stdout}\n${result.stderr}`.toLowerCase().includes("letagents");
}

function cursorPreflightReadyDetail(
  policy: ReturnType<typeof normalizeCursorMcpPolicy>,
  mcpStatus: DesktopMcpInstallTarget["status"] | null,
): string {
  if (policy === "normal") {
    return "This desktop can start Cursor in ask mode with normal Cursor MCP settings. Cursor may directly use any MCP tools configured in Cursor, including LetAgents if present.";
  }
  if (policy === "none") {
    return "This desktop can start Cursor in ask mode with MCP tools disabled in the managed profile. Write-capable Cursor remains gated on permissions tests.";
  }
  return mcpStatus === "installed"
    ? "This desktop can start Cursor in ask mode using managed MCP settings that keep user MCPs except LetAgents. Write-capable Cursor remains gated on permissions tests."
    : "This desktop can start Cursor directly in ask mode with managed MCP settings that filter LetAgents; install the LetAgents connection only for manual Cursor joins.";
}

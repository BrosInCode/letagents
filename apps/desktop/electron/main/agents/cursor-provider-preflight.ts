import { execFile } from "node:child_process";
import { resolve } from "node:path";

import type {
  DesktopAgentProvider,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderPreflightInput,
  DesktopManagedAgentPermissionProfileId,
  DesktopMcpInstallTarget,
} from "../../ipc-types.js";
import { normalizeCursorMcpPolicy, prepareCursorManagedProfile } from "./cursor-managed-profile.js";
import {
  cursorLaunchOptionsForPermissionProfile,
  cursorPermissionProfileReadyDetail,
} from "./cursor-permission-profile.js";
import { buildCursorChildEnv } from "./cursor-runner.js";
import { managedAgentPermissionProfileForProvider } from "./managed-agent-permission-profiles.js";

type ExecResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  errorCode: string | null;
};

type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

const COMMAND_TIMEOUT_MS = 8_000;

export type DesktopCursorPreflightOptions = {
  /**
   * Wall-clock cap per cursor-agent command. Defaults to COMMAND_TIMEOUT_MS;
   * pass 0 to disable (tests use this so results never depend on host load).
   */
  commandTimeoutMs?: number;
};

export async function runDesktopCursorProviderPreflight(
  provider: DesktopAgentProvider,
  input: DesktopAgentProviderPreflightInput,
  mcpStatus: DesktopMcpInstallTarget["status"] | null,
  options: DesktopCursorPreflightOptions = {},
): Promise<DesktopAgentProviderPreflight> {
  const timeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  const command = process.env.LETAGENTS_CURSOR_AGENT_BIN ||
    provider.runtimeCommand ||
    "cursor-agent";
  const versionResult = await execFileWithTimeout(command, ["--version"], { timeoutMs });
  if (commandMissing(versionResult)) {
    return {
      providerId: provider.id,
      status: "missing_runtime",
      canStart: false,
      message: "Cursor Agent is not installed.",
      detail: "Install Cursor Agent before starting a local Cursor room agent.",
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
  const requestedPermissionProfileId = normalizeRequestedPermissionProfileId(input.permissionProfileId);
  const permissionProfile = managedAgentPermissionProfileForProvider("cursor", requestedPermissionProfileId);
  if (requestedPermissionProfileId && permissionProfile.id !== requestedPermissionProfileId) {
    return {
      providerId: provider.id,
      status: "error",
      canStart: false,
      message: "Cursor permission profile is unknown.",
      detail: `Unknown permission profile '${requestedPermissionProfileId}' for Cursor.`,
      nextAction: null,
      version,
      mcpStatus,
    };
  }
  if (permissionProfile.status !== "available") {
    return {
      providerId: provider.id,
      status: "error",
      canStart: false,
      message: `${permissionProfile.label} is not available for Cursor.`,
      detail: permissionProfile.detail || permissionProfile.description,
      nextAction: null,
      version,
      mcpStatus,
    };
  }
  const launchOptions = cursorLaunchOptionsForPermissionProfile(permissionProfile.id);
  if (launchOptions.force || launchOptions.sandbox) {
    const flagResult = await execFileWithTimeout(command, ["--help"], { timeoutMs });
    if (!flagResult.ok || !cursorHelpSupportsLaunchOptions(flagResult, launchOptions)) {
      return {
        providerId: provider.id,
        status: "error",
        canStart: false,
        message: "Cursor Agent does not support the selected permission profile.",
        detail: "Update Cursor Agent so managed Cursor can use the required --force and --sandbox flags.",
        nextAction: null,
        version,
        mcpStatus,
      };
    }
  }
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
  const authResult = await execFileWithTimeout(command, ["status"], { env: managedEnv, timeoutMs });
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
      detail: "A desktop-managed Cursor agent needs a local repo or worktree.",
      nextAction: "choose_repo",
      version,
      mcpStatus,
    };
  }

  if (cursorMcpPolicy !== "normal") {
    const mcpResult = await execFileWithTimeout(command, ["mcp", "list"], {
      cwd: workspaceRoot,
      env: managedEnv,
      timeoutMs,
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
    if (cursorMcpPolicy === "none" && mcpListHasVisibleServers(mcpResult)) {
      return {
        providerId: provider.id,
        status: "error",
        canStart: false,
        message: "Cursor can still see MCP servers.",
        detail: "The No MCPs policy must not expose any Cursor MCP servers. Remove project-level MCP config or repair the managed profile.",
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
    message: `Cursor Agent is ready to start with ${permissionProfile.label}.`,
    detail: cursorPreflightReadyDetail(cursorMcpPolicy, mcpStatus, permissionProfile.id),
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
        timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
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

function mcpListHasVisibleServers(result: ExecResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`.trim().toLowerCase();
  return Boolean(
    output &&
    output !== "[]" &&
    !output.includes("no mcp") &&
    !output.includes("no servers"),
  );
}

function normalizeRequestedPermissionProfileId(
  value: DesktopAgentProviderPreflightInput["permissionProfileId"],
): DesktopManagedAgentPermissionProfileId | null {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized as DesktopManagedAgentPermissionProfileId : null;
}

function cursorHelpSupportsLaunchOptions(
  result: ExecResult,
  launchOptions: ReturnType<typeof cursorLaunchOptionsForPermissionProfile>,
): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  return (!launchOptions.force || output.includes("--force")) &&
    (!launchOptions.sandbox || output.includes("--sandbox"));
}

function cursorPreflightReadyDetail(
  policy: ReturnType<typeof normalizeCursorMcpPolicy>,
  mcpStatus: DesktopMcpInstallTarget["status"] | null,
  permissionProfileId: Parameters<typeof cursorPermissionProfileReadyDetail>[0],
): string {
  const permissionDetail = cursorPermissionProfileReadyDetail(permissionProfileId);
  if (policy === "normal") {
    return `${permissionDetail} The normal Cursor MCP settings are enabled; Cursor may directly use any MCP tools configured in Cursor, including LetAgents if present.`;
  }
  if (policy === "none") {
    return `${permissionDetail} MCP tools are disabled in the managed profile.`;
  }
  return mcpStatus === "installed"
    ? `${permissionDetail} Managed MCP settings keep user MCPs except LetAgents.`
    : `${permissionDetail} Managed MCP settings filter LetAgents; install the LetAgents connection only for manual Cursor joins.`;
}

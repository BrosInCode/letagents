import { execFile, spawn } from "node:child_process";

import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderPreflightInput,
  DesktopAgentProviderSetupInput,
  DesktopAgentProviderSetupResult,
  DesktopMcpInstallTarget,
} from "../../ipc-types.js";
import {
  buildMcpInstallState,
  installLetAgentsMcpServer,
} from "../mcp-setup.js";
import { isDesktopSmokeCheck } from "../smoke.js";
import { codexInstallCommand } from "./codex-install.js";
import { providerSetupConfirmationResult } from "./provider-setup-confirmation.js";

type ExecResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  errorCode: string | null;
};

const COMMAND_TIMEOUT_MS = 8_000;

const agentProviders: DesktopAgentProvider[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Start a Claude Code agent here.",
    capabilities: [
      "external_mcp",
      "desktop_managed_runtime",
      "auth_preflight",
      "turn_control",
    ],
    runtimeCommand: "claude",
    mcpTargetId: "claude-code",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    description: "Join from Antigravity.",
    capabilities: ["external_mcp"],
    runtimeCommand: null,
    mcpTargetId: "antigravity",
  },
  {
    id: "cursor",
    name: "Cursor",
    description: "Join from Cursor.",
    capabilities: ["external_mcp"],
    runtimeCommand: null,
    mcpTargetId: "cursor",
  },
  {
    id: "codex",
    name: "Codex",
    description: "Start a Codex agent here.",
    capabilities: [
      "external_mcp",
      "desktop_managed_runtime",
      "installable_runtime",
      "auth_preflight",
      "turn_control",
      "reasoning_stream",
    ],
    runtimeCommand: "codex",
    mcpTargetId: "codex",
  },
];

export function listDesktopAgentProviders(): DesktopAgentProvider[] {
  return agentProviders.map((provider) => ({ ...provider, capabilities: [...provider.capabilities] }));
}

function assertAgentProviderId(providerId: string): asserts providerId is DesktopAgentProviderId {
  if (!agentProviders.some((provider) => provider.id === providerId)) {
    throw new Error(`Unknown agent provider: ${providerId}`);
  }
}

function findAgentProvider(providerId: DesktopAgentProviderId): DesktopAgentProvider {
  const provider = agentProviders.find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw new Error(`Unknown agent provider: ${providerId}`);
  }
  return provider;
}

async function execFileWithTimeout(command: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { timeout: COMMAND_TIMEOUT_MS }, (error, stdout, stderr) => {
      const nodeError = error as NodeJS.ErrnoException | null;
      resolve({
        ok: !error,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        errorCode: nodeError?.code ? String(nodeError.code) : null,
      });
    });
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

async function getProviderMcpStatus(
  provider: DesktopAgentProvider,
): Promise<DesktopMcpInstallTarget["status"] | null> {
  const state = await buildMcpInstallState();
  return state.targets.find((target) => target.id === provider.mcpTargetId)?.status ?? null;
}

function bridgePreflight(
  provider: DesktopAgentProvider,
  mcpStatus: DesktopMcpInstallTarget["status"] | null,
): DesktopAgentProviderPreflight {
  if (mcpStatus === "installed") {
    return {
      providerId: provider.id,
      status: "ready",
      canStart: false,
      message: `${provider.name} is connected to LetAgents.`,
      detail: "Open this agent app, then ask it to join this room through LetAgents.",
      nextAction: null,
      version: null,
      mcpStatus,
    };
  }

  return {
    providerId: provider.id,
    status: "bridge_required",
    canStart: false,
    message: `${provider.name} needs the LetAgents connection.`,
    detail: "Install or repair the agent app connection before this provider can join rooms.",
    nextAction: "install_mcp_bridge",
    version: null,
    mcpStatus,
  };
}

async function codexPreflight(
  provider: DesktopAgentProvider,
  input: DesktopAgentProviderPreflightInput,
  mcpStatus: DesktopMcpInstallTarget["status"] | null,
): Promise<DesktopAgentProviderPreflight> {
  const command = process.env.LETAGENTS_CODEX_BIN || provider.runtimeCommand || "codex";
  const versionResult = await execFileWithTimeout(command, ["--version"]);
  if (commandMissing(versionResult)) {
    return {
      providerId: provider.id,
      status: "missing_runtime",
      canStart: false,
      message: "Codex is not installed.",
      detail: "Install the official Codex CLI runtime before starting a local Codex room agent.",
      nextAction: "install_runtime",
      version: null,
      mcpStatus,
    };
  }
  if (!versionResult.ok) {
    return {
      providerId: provider.id,
      status: "error",
      canStart: false,
      message: "Codex could not be checked.",
      detail: firstOutputLine(versionResult) || "The Codex command failed before returning a version.",
      nextAction: null,
      version: null,
      mcpStatus,
    };
  }

  const version = firstOutputLine(versionResult);
  const authResult = await execFileWithTimeout(command, ["login", "status"]);
  if (!authResult.ok) {
    return {
      providerId: provider.id,
      status: "auth_required",
      canStart: false,
      message: "Codex needs sign-in.",
      detail: firstOutputLine(authResult) || "Sign in with Codex before starting a local room agent.",
      nextAction: "authenticate",
      version,
      mcpStatus,
    };
  }

  if (mcpStatus !== "installed") {
    return {
      providerId: provider.id,
      status: "bridge_required",
      canStart: false,
      message: "Codex needs the LetAgents connection.",
      detail: "Install or repair the Codex connection so the local agent can act in rooms.",
      nextAction: "install_mcp_bridge",
      version,
      mcpStatus,
    };
  }

  if (!input.repoRootPath?.trim()) {
    return {
      providerId: provider.id,
      status: "repo_required",
      canStart: false,
      message: "Choose a local repository before starting Codex.",
      detail: "A desktop-managed Codex agent needs a local repo or worktree for code actions.",
      nextAction: "choose_repo",
      version,
      mcpStatus,
    };
  }

  return {
    providerId: provider.id,
    status: "ready",
    canStart: true,
    message: "Codex is ready to start.",
    detail: "This desktop can start and monitor a local Codex agent.",
    nextAction: null,
    version,
    mcpStatus,
  };
}

async function claudeCodePreflight(
  provider: DesktopAgentProvider,
  input: DesktopAgentProviderPreflightInput,
  mcpStatus: DesktopMcpInstallTarget["status"] | null,
): Promise<DesktopAgentProviderPreflight> {
  const command = process.env.LETAGENTS_CLAUDE_CODE_BIN ||
    process.env.LETAGENTS_CLAUDE_BIN ||
    provider.runtimeCommand ||
    "claude";
  const versionResult = await execFileWithTimeout(command, ["--version"]);
  if (commandMissing(versionResult)) {
    return {
      providerId: provider.id,
      status: "missing_runtime",
      canStart: false,
      message: "Claude Code is not installed.",
      detail: "Install the official Claude Code runtime before starting a local Claude Code room agent.",
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
      message: "Claude Code could not be checked.",
      detail: firstOutputLine(versionResult) || "The Claude Code command failed before returning a version.",
      nextAction: null,
      version: null,
      mcpStatus,
    };
  }

  const version = firstOutputLine(versionResult);
  const authResult = await execFileWithTimeout(command, ["auth", "status"]);
  if (!authResult.ok) {
    return {
      providerId: provider.id,
      status: "auth_required",
      canStart: false,
      message: "Claude Code needs sign-in.",
      detail: firstOutputLine(authResult) || "Sign in with Claude Code before starting a local room agent.",
      nextAction: "authenticate",
      version,
      mcpStatus,
    };
  }

  if (!input.repoRootPath?.trim()) {
    return {
      providerId: provider.id,
      status: "repo_required",
      canStart: false,
      message: "Choose a local repository before starting Claude Code.",
      detail: "A desktop-managed Claude Code agent needs a local repo or worktree for code actions.",
      nextAction: "choose_repo",
      version,
      mcpStatus,
    };
  }

  return {
    providerId: provider.id,
    status: "ready",
    canStart: true,
    message: "Claude Code is ready to start.",
    detail: mcpStatus === "installed"
      ? "This desktop can start and monitor a local Claude Code agent."
      : "This desktop can start Claude Code directly; install the LetAgents connection only for manual Claude Code joins.",
    nextAction: null,
    version,
    mcpStatus,
  };
}

export async function runDesktopAgentProviderPreflight(
  providerId: DesktopAgentProviderId,
  input: DesktopAgentProviderPreflightInput = {},
): Promise<DesktopAgentProviderPreflight> {
  assertAgentProviderId(providerId);
  const provider = findAgentProvider(providerId);
  if (isDesktopSmokeCheck()) {
    if (provider.id === "codex") {
      return {
        providerId: provider.id,
        status: "missing_runtime",
        canStart: false,
        message: "Codex is not installed.",
        detail: "Install the official Codex CLI runtime before starting a local Codex room agent.",
        nextAction: "install_runtime",
        version: null,
        mcpStatus: "installed",
      };
    }
    return {
      providerId: provider.id,
      status: provider.capabilities.includes("desktop_managed_runtime")
        ? input.repoRootPath?.trim()
          ? "ready"
          : "repo_required"
        : "ready",
      canStart: provider.capabilities.includes("desktop_managed_runtime") && Boolean(input.repoRootPath?.trim()),
      message: provider.capabilities.includes("desktop_managed_runtime")
        ? input.repoRootPath?.trim()
          ? `${provider.name} is ready to start.`
          : `Choose a local repository before starting ${provider.name}.`
        : `${provider.name} is connected to LetAgents.`,
      detail: provider.capabilities.includes("desktop_managed_runtime")
        ? input.repoRootPath?.trim()
          ? "Smoke mode can launch and supervise this local provider."
          : "A desktop-managed agent needs a local repo or worktree for code actions."
        : "Open this agent app, then ask it to join this room through LetAgents.",
      nextAction: provider.capabilities.includes("desktop_managed_runtime") && !input.repoRootPath?.trim()
        ? "choose_repo"
        : null,
      version: provider.id === "codex" ? "codex smoke" : null,
      mcpStatus: "installed",
    };
  }
  const mcpStatus = await getProviderMcpStatus(provider);

  if (provider.id === "codex") {
    return codexPreflight(provider, input, mcpStatus);
  }
  if (provider.id === "claude-code") {
    return claudeCodePreflight(provider, input, mcpStatus);
  }

  return bridgePreflight(provider, mcpStatus);
}

async function installCodexRuntime(confirmed: boolean | undefined): Promise<DesktopAgentProviderSetupResult> {
  if (!confirmed) {
    return providerSetupConfirmationResult({ id: "codex", name: "Codex" }, "install_runtime");
  }

  if (isDesktopSmokeCheck()) {
    return {
      providerId: "codex",
      action: "install_runtime",
      success: true,
      message: "Codex was installed.",
      detail: "Smoke mode skipped the Codex installer.",
    };
  }

  const install = codexInstallCommand();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(install.command, install.args, {
      stdio: "ignore",
      detached: false,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Codex installer exited with code ${code ?? "unknown"}.`));
    });
  });

  return {
    providerId: "codex",
    action: "install_runtime",
    success: true,
    message: "Codex was installed.",
    detail: install.detail,
  };
}

export async function runDesktopAgentProviderSetup(
  providerId: DesktopAgentProviderId,
  input: DesktopAgentProviderSetupInput,
): Promise<DesktopAgentProviderSetupResult> {
  assertAgentProviderId(providerId);
  const provider = findAgentProvider(providerId);

  if (input.action === "install_mcp_bridge") {
    if (!input.confirmed) {
      return providerSetupConfirmationResult(provider, input.action);
    }

    const result = await installLetAgentsMcpServer(
      provider.mcpTargetId,
    );
    return {
      providerId,
      action: input.action,
      success: result.success,
      message: result.message,
      detail: result.target.restartHint,
    };
  }

  if (input.action === "install_runtime" && provider.id === "codex") {
    return installCodexRuntime(input.confirmed);
  }

  throw new Error(`${provider.name} does not support ${input.action}.`);
}

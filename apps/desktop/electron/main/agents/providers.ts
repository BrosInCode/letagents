import { execFile, spawn } from "node:child_process";

import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderPreflightInput,
  DesktopAgentProviderSetupInput,
  DesktopAgentProviderSetupResult,
  DesktopGitRoomInfo,
  DesktopMcpInstallTarget,
} from "../../ipc-types.js";
import { buildRepoStatus } from "../../repo-status.js";
import {
  buildMcpInstallState,
  installLetAgentsMcpServer,
} from "../mcp-setup.js";
import { isDesktopSmokeCheck } from "../smoke.js";
import {
  getLocalRoom,
  getLocalRoomByCloudRoom,
} from "../rooms/local-store.js";
import {
  firstRedactedCodexAppServerOutputLine,
  sensitiveCodexAppServerEnvValues,
} from "./codex-app-server.js";
import { resolveCodexExecutable } from "./codex-executable.js";
import {
  openCodeInstallCommand,
  resolveOpenCodeBinary,
} from "./opencode-runtime.js";
import { getOpenModelSettingsStatus } from "./open-model-settings.js";
import { runDesktopCursorProviderPreflight } from "./cursor-provider-preflight.js";
import {
  normalizeManagedAgentModel,
  validateDesktopManagedAgentModel,
} from "./managed-agent-models.js";
import {
  applyManagedAgentBranchScopePreflight,
  branchScopedGitRoomName,
  gitRoomFromBranchRoomIdentifier,
} from "./managed-agent-branch-scope.js";
import { inspectClaudeCodeVersion, resolveClaudeCodeExecutable } from "./claude-code-version.js";
import {
  getDesktopAgentProvider,
  isDesktopAgentProviderId,
} from "./provider-registry.js";
import { providerSetupConfirmationResult } from "./provider-setup-confirmation.js";
import { missingExternalRuntimePreflight } from "./external-runtime-preflight.js";
import {
  desktopRuntimeEnvironment,
  desktopShellEnvironmentReady,
  refreshDesktopShellEnvironment,
} from "../desktop-shell-environment.js";
import { supervisorDaemonClient } from "../supervisor-daemon.js";

export { listDesktopAgentProviders } from "./provider-registry.js";

type ExecResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  errorCode: string | null;
  redactions: string[];
};

type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

const COMMAND_TIMEOUT_MS = 8_000;

export type DesktopAgentProviderPreflightOptions = {
  /**
   * Wall-clock cap per provider CLI command. Defaults to COMMAND_TIMEOUT_MS;
   * pass 0 to disable (tests use this so results never depend on host load).
   */
  commandTimeoutMs?: number;
};

function assertAgentProviderId(providerId: string): asserts providerId is DesktopAgentProviderId {
  if (!isDesktopAgentProviderId(providerId)) {
    throw new Error(`Unknown agent provider: ${providerId}`);
  }
}

function findAgentProvider(providerId: DesktopAgentProviderId): DesktopAgentProvider {
  const provider = getDesktopAgentProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown agent provider: ${providerId}`);
  }
  return provider;
}

async function execFileWithTimeout(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const env = options.env || process.env;
    const child = execFile(
      command,
      args,
      {
        timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
        cwd: options.cwd,
        env,
      },
      (error, stdout, stderr) => {
        const nodeError = error as NodeJS.ErrnoException | null;
        resolve({
          ok: !error,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          errorCode: nodeError?.code ? String(nodeError.code) : null,
          redactions: sensitiveCodexAppServerEnvValues(env),
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
  return firstRedactedCodexAppServerOutputLine(
    result.stdout,
    result.stderr,
    result.redactions,
  );
}

async function getProviderMcpStatus(
  provider: DesktopAgentProvider,
): Promise<DesktopMcpInstallTarget["status"] | null> {
  if (!provider.mcpTargetId) return null;
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
  timeoutMs?: number,
): Promise<DesktopAgentProviderPreflight> {
  const runtimeEnv = desktopRuntimeEnvironment();
  const resolvedCommand = resolveCodexExecutable({ env: runtimeEnv });
  const versionResult = await execFileWithTimeout(resolvedCommand, ["--version"], { timeoutMs, env: runtimeEnv });
  if (commandMissing(versionResult)) {
    return missingExternalRuntimePreflight(provider, mcpStatus);
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
  const authResult = await execFileWithTimeout(resolvedCommand, ["login", "status"], { timeoutMs, env: runtimeEnv });
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
  timeoutMs?: number,
): Promise<DesktopAgentProviderPreflight> {
  const runtimeEnv = desktopRuntimeEnvironment();
  const command = resolveClaudeCodeExecutable(runtimeEnv, provider.runtimeCommand || "claude");
  const versionResult = await execFileWithTimeout(command, ["--version"], { timeoutMs, env: runtimeEnv });
  if (commandMissing(versionResult)) {
    return missingExternalRuntimePreflight(provider, mcpStatus);
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
  const versionReadiness = inspectClaudeCodeVersion(version ?? "");
  if (!versionReadiness.supported) {
    return {
      providerId: provider.id,
      status: "error",
      canStart: false,
      message: "Claude Code needs an update.",
      detail: versionReadiness.error,
      nextAction: null,
      version,
      mcpStatus,
    };
  }
  const authResult = await execFileWithTimeout(command, ["auth", "status"], { timeoutMs, env: runtimeEnv });
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
    detail: "This desktop supplies the managed LetAgents connection and can start and monitor a local Claude Code agent.",
    nextAction: null,
    version,
    mcpStatus,
  };
}

async function openModelPreflight(
  provider: DesktopAgentProvider,
  input: DesktopAgentProviderPreflightInput,
  mcpStatus: DesktopMcpInstallTarget["status"] | null,
  timeoutMs?: number,
): Promise<DesktopAgentProviderPreflight> {
  const command = resolveOpenCodeBinary();
  const versionResult = await execFileWithTimeout(command, ["--version"], { timeoutMs });
  if (commandMissing(versionResult)) {
    return {
      providerId: provider.id,
      status: "missing_runtime",
      canStart: false,
      message: "The OpenCode execution engine is not installed.",
      detail: "Development builds need OpenCode on PATH. Release builds include a pinned OpenCode runtime.",
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
      message: "The OpenCode execution engine could not be checked.",
      detail: firstOutputLine(versionResult) || "The OpenCode command failed before returning a version.",
      nextAction: null,
      version: null,
      mcpStatus,
    };
  }

  const version = firstOutputLine(versionResult);
  const settings = await getOpenModelSettingsStatus();
  const effectiveModel = normalizeManagedAgentModel(input.model) || settings.model;
  if (settings.error) {
    return {
      providerId: provider.id,
      status: "error",
      canStart: false,
      message: "Open model settings could not be read.",
      detail: settings.error,
      nextAction: null,
      version,
      mcpStatus,
    };
  }
  if (!settings.baseUrl || !effectiveModel) {
    return {
      providerId: provider.id,
      status: "config_required",
      canStart: false,
      message: "Configure a model endpoint before starting an Open Model agent.",
      detail: "Add an OpenAI-compatible endpoint URL (OpenRouter, vLLM, Ollama, …) and save a default model or choose one below. Paste a provider API key only when that endpoint requires one; OpenCode itself has no separate login.",
      nextAction: null,
      version,
      mcpStatus,
    };
  }

  if (!input.repoRootPath?.trim()) {
    return {
      providerId: provider.id,
      status: "repo_required",
      canStart: false,
      message: "Choose a local repository before starting an Open Model agent.",
      detail: "A desktop-managed agent needs a local repo or worktree for code actions.",
      nextAction: "choose_repo",
      version,
      mcpStatus,
    };
  }

  return {
    providerId: provider.id,
    status: "ready",
    canStart: true,
    message: "Open Model is ready to start.",
    detail: `Runs ${effectiveModel} through OpenCode and your configured endpoint${settings.hasApiKey ? " using your encrypted provider API key" : ""}. No OpenCode account is required.`,
    nextAction: null,
    version: version ? `${version} - ${effectiveModel}` : effectiveModel,
    mcpStatus,
  };
}

export async function runDesktopAgentProviderPreflight(
  providerId: DesktopAgentProviderId,
  input: DesktopAgentProviderPreflightInput = {},
  options: DesktopAgentProviderPreflightOptions = {},
): Promise<DesktopAgentProviderPreflight> {
  if (input.refreshEnvironment) {
    const refresh = await refreshDesktopShellEnvironment();
    if (refresh.changed && (process.platform === "darwin" || process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON === "1")) {
      await supervisorDaemonClient.restartForEnvironmentRefresh();
    }
  } else {
    await desktopShellEnvironmentReady();
  }
  assertAgentProviderId(providerId);
  const provider = findAgentProvider(providerId);
  const withManagedRuntimeValidation = async (
    result: DesktopAgentProviderPreflight,
  ): Promise<DesktopAgentProviderPreflight> => {
    if (
      !result.canStart
      || (
        !provider.capabilities.includes("desktop_managed_runtime")
        && !provider.capabilities.includes("supervised_runtime")
      )
    ) {
      return result;
    }
    const validation = await validateDesktopManagedAgentModel({
      providerId,
      ...input,
    });
    if (validation.error) {
      return {
        ...result,
        status: "config_required",
        canStart: false,
        message: "Selected model is not available.",
        detail: validation.error,
      };
    }

    const gitRoom = await resolveManagedAgentPreflightGitRoom(input);
    const branchScopedName = branchScopedGitRoomName(gitRoom);
    if (!branchScopedName) {
      return result;
    }

    const repoRootPath = input.repoRootPath?.trim();
    const repoStatus = repoRootPath
      ? await buildRepoStatus(repoRootPath).catch(() => null)
      : null;
    return applyManagedAgentBranchScopePreflight({
      providerName: provider.name,
      preflight: result,
      gitRoom,
      repoStatus,
    });
  };
  if (isDesktopSmokeCheck()) {
    if (provider.id === "codex") {
      return withManagedRuntimeValidation(missingExternalRuntimePreflight(provider, "installed"));
    }
    if (provider.id === "open-model") {
      return {
        providerId: provider.id,
        status: "missing_runtime",
        canStart: false,
        message: "The OpenCode execution engine is not installed.",
        detail: "Smoke mode exposes the managed runtime confirmation flow.",
        nextAction: "install_runtime",
        version: null,
        mcpStatus: null,
      };
    }
    return withManagedRuntimeValidation({
      providerId: provider.id,
      status: (
        provider.capabilities.includes("desktop_managed_runtime")
        || provider.capabilities.includes("supervised_runtime")
      )
        ? input.repoRootPath?.trim()
          ? "ready"
          : "repo_required"
        : "ready",
      canStart: (
        provider.capabilities.includes("desktop_managed_runtime")
        || provider.capabilities.includes("supervised_runtime")
      ) && Boolean(input.repoRootPath?.trim()),
      message: (
        provider.capabilities.includes("desktop_managed_runtime")
        || provider.capabilities.includes("supervised_runtime")
      )
        ? input.repoRootPath?.trim()
          ? `${provider.name} is ready to start.`
          : `Choose a local repository before starting ${provider.name}.`
        : `${provider.name} is connected to LetAgents.`,
      detail: (
        provider.capabilities.includes("desktop_managed_runtime")
        || provider.capabilities.includes("supervised_runtime")
      )
        ? input.repoRootPath?.trim()
          ? "The desktop can launch and supervise this local provider."
          : "A supervised agent needs a local repo or worktree for code actions."
        : "Open this agent app, then ask it to join this room through LetAgents.",
      nextAction: (
        provider.capabilities.includes("desktop_managed_runtime")
        || provider.capabilities.includes("supervised_runtime")
      ) && !input.repoRootPath?.trim()
        ? "choose_repo"
        : null,
      version: provider.id === "codex" ? "codex smoke" : null,
      mcpStatus: "installed",
    });
  }
  const mcpStatus = await getProviderMcpStatus(provider);

  if (provider.id === "codex") {
    return withManagedRuntimeValidation(await codexPreflight(provider, input, mcpStatus, options.commandTimeoutMs));
  }
  if (provider.id === "claude-code") {
    return withManagedRuntimeValidation(await claudeCodePreflight(provider, input, mcpStatus, options.commandTimeoutMs));
  }
  if (provider.id === "cursor") {
    return withManagedRuntimeValidation(await runDesktopCursorProviderPreflight(provider, input, mcpStatus, {
      commandTimeoutMs: options.commandTimeoutMs,
    }));
  }
  if (provider.id === "open-model") {
    return withManagedRuntimeValidation(await openModelPreflight(provider, input, mcpStatus, options.commandTimeoutMs));
  }

  return bridgePreflight(provider, mcpStatus);
}

async function resolveManagedAgentPreflightGitRoom(
  input: DesktopAgentProviderPreflightInput,
): Promise<DesktopGitRoomInfo | null> {
  const identifierGitRoom = gitRoomFromBranchRoomIdentifier(input.roomIdentifier);
  if (identifierGitRoom) return identifierGitRoom;
  if (input.roomGitRoom) return input.roomGitRoom;

  const roomIdentifier = input.roomIdentifier?.trim();
  if (!roomIdentifier) return null;
  const localRoom = await getLocalRoom(roomIdentifier)
    || await getLocalRoomByCloudRoom(roomIdentifier);
  return localRoom?.gitRoom ?? null;
}

async function installOpenCodeRuntime(
  confirmed: boolean | undefined,
  provider: DesktopAgentProvider,
): Promise<DesktopAgentProviderSetupResult> {
  if (!confirmed) {
    return providerSetupConfirmationResult({ id: provider.id, name: provider.name }, "install_runtime");
  }
  if (isDesktopSmokeCheck()) {
    return {
      providerId: provider.id,
      action: "install_runtime",
      success: true,
      message: "OpenCode was installed.",
      detail: "Smoke mode skipped the OpenCode installer.",
    };
  }
  const install = openCodeInstallCommand();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(install.command, install.args, { stdio: "ignore", detached: false });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`OpenCode installer exited with code ${code ?? "unknown"}.`)));
  });
  return {
    providerId: provider.id,
    action: "install_runtime",
    success: true,
    message: "OpenCode was installed.",
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
    if (!provider.mcpTargetId) {
      throw new Error(`${provider.name} embeds its LetAgents bridge and has no external MCP installation target.`);
    }
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

  if (input.action === "install_runtime" && provider.id === "open-model") {
    return installOpenCodeRuntime(input.confirmed, provider);
  }

  throw new Error(`${provider.name} does not support ${input.action}.`);
}

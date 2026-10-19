import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  DesktopAgentProvider,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderPreflightInput,
  DesktopManagedAgentPermissionProfileId,
  DesktopMcpInstallTarget,
} from "../../ipc-types.js";
import {
  prepareCursorSupervisedProfile,
  type CursorManagedProfile,
} from "./cursor-managed-profile.js";
import {
  assertCursorSupervisedMcpAuthority,
  cursorMcpInspectionEnv,
} from "./cursor-mcp-authority.js";
import {
  cursorLaunchOptionsForPermissionProfile,
  cursorPermissionProfileReadyDetail,
} from "./cursor-permission-profile.js";
import {
  assertCursorPersonalIdentity,
  CursorIdentityAuthRequiredError,
} from "./cursor-provider-adapter.js";
import { buildCursorChildEnv } from "./cursor-runner.js";
import {
  resolveLetAgentsMcpRuntime,
  type LetAgentsMcpRuntime,
} from "./letagents-mcp-runtime.js";
import { managedAgentPermissionProfileForProvider } from "./managed-agent-permission-profiles.js";
import { cachedProbe, probeKey } from "./provider-probe-cache.js";
import { assertSupervisedWorkspaceGenerationSupported } from "./supervised-workspace-generation.js";
import { apiUrl as desktopApiUrl, workspaceRoot as sourceWorkspaceRoot } from "../paths.js";
import { desktopRuntimeEnvironment } from "../desktop-shell-environment.js";
import { missingExternalRuntimePreflight } from "./external-runtime-preflight.js";

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
  /** Injectable exact runtime for tests; production resolves the signed copy. */
  mcpRuntime?: LetAgentsMcpRuntime;
  /** Test seam for the live, identity-only GetMe attestation. */
  personalIdentityAttestor?: typeof assertCursorPersonalIdentity;
  /** Lightweight Git/topology check; it must never inventory project files. */
  workspaceGenerationSupportChecker?: typeof assertSupervisedWorkspaceGenerationSupported;
  /** Exact environment snapshot used by every executable probe; injectable for tests. */
  runtimeEnvironment?: NodeJS.ProcessEnv;
};

export async function runDesktopCursorProviderPreflight(
  provider: DesktopAgentProvider,
  input: DesktopAgentProviderPreflightInput,
  mcpStatus: DesktopMcpInstallTarget["status"] | null,
  options: DesktopCursorPreflightOptions = {},
): Promise<DesktopAgentProviderPreflight> {
  const timeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  const runtimeEnv = options.runtimeEnvironment ?? desktopRuntimeEnvironment();
  const command = runtimeEnv.LETAGENTS_CURSOR_AGENT_BIN ||
    provider.runtimeCommand ||
    "cursor-agent";
  const versionResult = await cachedProbe(probeKey(command, ["--version"]), () =>
    execFileWithTimeout(command, ["--version"], { timeoutMs, env: runtimeEnv }));
  if (commandMissing(versionResult)) {
    return missingExternalRuntimePreflight(provider, mcpStatus);
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
  const requestedPermissionProfileId = normalizeRequestedPermissionProfileId(input.permissionProfileId);
  const permissionProfile = managedAgentPermissionProfileForProvider(
    "cursor",
    requestedPermissionProfileId ?? "sandboxed_write",
  );
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
  const flagResult = await cachedProbe(probeKey(command, ["--help"], workspaceRoot), () =>
    execFileWithTimeout(command, ["--help"], {
      cwd: workspaceRoot ?? undefined,
      env: runtimeEnv,
      timeoutMs,
    }));
  if (!flagResult.ok || !cursorHelpSupportsLaunchOptions(flagResult, launchOptions)) {
    return {
      providerId: provider.id,
      status: "error",
      canStart: false,
      message: "Cursor Agent does not support the selected permission profile.",
      detail: "Update Cursor Agent to use this access level.",
      nextAction: null,
      version,
      mcpStatus,
    };
  }
  const roomOnlyReadOnly = input.roomOnly === true
    && !workspaceRoot
    && permissionProfile.id === "read_only";
  if (!workspaceRoot && !roomOnlyReadOnly) {
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

  let preflightWorkspaceRoot = workspaceRoot;
  let managedProfile: CursorManagedProfile;
  let supervisedMcpRuntime: LetAgentsMcpRuntime | undefined;
  let preflightProfileRoot: string | null = null;
  const cleanupPreflightDirectories = () => {
    if (preflightProfileRoot) rmSync(preflightProfileRoot, { recursive: true, force: true });
    if (roomOnlyReadOnly && preflightWorkspaceRoot) {
      rmSync(preflightWorkspaceRoot, { recursive: true, force: true });
    }
  };
  try {
    if (roomOnlyReadOnly) {
      preflightWorkspaceRoot = mkdtempSync(join(tmpdir(), "letagents-cursor-workspace-preflight-"));
    }
    preflightProfileRoot = mkdtempSync(join(tmpdir(), "letagents-cursor-preflight-"));
    try {
      supervisedMcpRuntime = options.mcpRuntime ?? resolveLetAgentsMcpRuntime({
        devEntryPath: process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL?.trim()
          ? join(sourceWorkspaceRoot, "dist", "mcp", "server.js")
          : undefined,
      });
      managedProfile = prepareCursorSupervisedProfile({
        workAttemptId: `preflight:${preflightWorkspaceRoot}`,
        apiBaseUrl: desktopApiUrl,
        workspaceRoot: preflightWorkspaceRoot!,
        profileRoot: preflightProfileRoot,
        mcpRuntime: supervisedMcpRuntime,
        identityAttestationOnly: true,
        inspectionOnly: true,
        mcpWorkingDirectory: preflightProfileRoot,
      });
    } catch (error) {
      return {
        providerId: provider.id,
        status: "error",
        canStart: false,
        message: "Could not set up Cursor for this agent.",
        detail: error instanceof Error ? error.message : String(error),
        nextAction: null,
        version,
        mcpStatus,
      };
    }
    let managedEnv = buildCursorChildEnv(managedProfile.env);
    delete managedEnv.CURSOR_API_KEY;
    delete managedEnv.CURSOR_AUTH_TOKEN;
    let attestedPersonalIdentity: Awaited<ReturnType<typeof assertCursorPersonalIdentity>>;
    try {
      attestedPersonalIdentity = await (options.personalIdentityAttestor ?? assertCursorPersonalIdentity)({
        cursorBin: command,
        cwd: preflightProfileRoot,
        env: managedEnv,
        writableProfileRoot: preflightProfileRoot,
        requiredReadableRoots: managedProfile.authReadRoots,
        timeoutMs,
      });
    } catch (error) {
      if (error instanceof CursorIdentityAuthRequiredError) {
        return {
          providerId: provider.id,
          status: "auth_required",
          canStart: false,
          message: "Cursor Agent needs sign-in.",
          detail: error.message,
          nextAction: "authenticate",
          version,
          mcpStatus,
        };
      }
      return {
        providerId: provider.id,
        status: "error",
        canStart: false,
        message: "Could not verify the Cursor account in use.",
        detail: error instanceof Error ? error.message : String(error),
        nextAction: null,
        version,
        mcpStatus,
      };
    }
    if (workspaceRoot && permissionProfile.id === "sandboxed_write") {
      try {
        await (options.workspaceGenerationSupportChecker ?? assertSupervisedWorkspaceGenerationSupported)(workspaceRoot);
      } catch (error) {
        return {
          providerId: provider.id,
          status: "error",
          canStart: false,
          message: "LetAgents cannot safely track Cursor’s changes in this folder.",
          detail: error instanceof Error ? error.message : String(error),
          nextAction: null,
          version,
          mcpStatus,
        };
      }
    }

    const resealAuthenticatedSupervisedProfile = async (): Promise<DesktopAgentProviderPreflight | null> => {
      if (!preflightProfileRoot || !supervisedMcpRuntime) return null;
      try {
        managedProfile = prepareCursorSupervisedProfile({
          workAttemptId: `preflight:${preflightWorkspaceRoot}`,
          apiBaseUrl: desktopApiUrl,
          workspaceRoot: preflightWorkspaceRoot!,
          permissionProfileId: permissionProfile.id,
          profileRoot: preflightProfileRoot,
          mcpRuntime: supervisedMcpRuntime,
          authSourceHomeDir: managedProfile.homeDir,
          attestedPersonalIdentity,
        });
        managedEnv = buildCursorChildEnv(managedProfile.env);
        delete managedEnv.CURSOR_API_KEY;
        delete managedEnv.CURSOR_AUTH_TOKEN;
        return null;
      } catch (error) {
        return {
          providerId: provider.id,
          status: "error",
          canStart: false,
          message: "LetAgents could not verify this Cursor sign-in.",
          detail: error instanceof Error ? error.message : String(error),
          nextAction: null,
          version,
          mcpStatus,
        };
      }
    };
    const postAuthProfileError = await resealAuthenticatedSupervisedProfile();
    if (postAuthProfileError) return postAuthProfileError;

    if (preflightProfileRoot && supervisedMcpRuntime) {
      // Prove both the hidden project-config suppression flag and the exact
      // packaged bridge from a fresh credentialless profile. The authority
      // wrapper denies network and confines reads, writes, and process exec;
      // never run Cursor's side-effectful `mcp list` against an authenticated
      // profile merely to render a preflight screen.
      const authorityProfileRoot = join(preflightProfileRoot, "authority");
      try {
        const authorityProfile = prepareCursorSupervisedProfile({
          workAttemptId: `preflight-authority:${preflightWorkspaceRoot}`,
          apiBaseUrl: desktopApiUrl,
          workspaceRoot: preflightWorkspaceRoot!,
          profileRoot: authorityProfileRoot,
          includeAuth: false,
          mcpRuntime: supervisedMcpRuntime,
          mcpWorkingDirectory: authorityProfileRoot,
        });
        await assertCursorSupervisedMcpAuthority({
          cursorBin: command,
          cwd: authorityProfileRoot,
          env: cursorMcpInspectionEnv({
            ...buildCursorChildEnv(authorityProfile.env),
            AGENT_CLI_CREDENTIAL_STORE: "file",
          }),
          writableProfileRoot: authorityProfileRoot,
          requiredReadableRoots: authorityProfile.mcpRuntimeReadRoots,
          expectedServerName: authorityProfile.mcpServerName,
          timeoutMs,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          providerId: provider.id,
          status: "error",
          canStart: false,
          message: "LetAgents could not verify Cursor’s connected tools.",
          detail,
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
      message: `Cursor Agent is ready to start supervised with ${
        permissionProfile.id === "sandboxed_write"
          ? "Workspace writes"
          : permissionProfile.id === "full_access"
            ? "Full access"
            : permissionProfile.label
      }.`,
      detail: cursorPreflightReadyDetail(permissionProfile.id),
      nextAction: null,
      version,
      mcpStatus,
    };
  } finally {
    cleanupPreflightDirectories();
  }
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
    output.includes("--sandbox") &&
    output.includes("--trust");
}

function cursorPreflightReadyDetail(
  permissionProfileId: Parameters<typeof cursorPermissionProfileReadyDetail>[0],
): string {
  return `${cursorPermissionProfileReadyDetail(permissionProfileId)} This agent connects only to LetAgents room tools and keeps running when the desktop app restarts.`;
}

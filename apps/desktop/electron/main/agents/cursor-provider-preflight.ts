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
  normalizeCursorMcpPolicy,
  prepareCursorManagedProfile,
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
import { assertSupervisedWorkspaceGenerationSupported } from "./supervised-workspace-generation.js";
import { apiUrl as desktopApiUrl, workspaceRoot as sourceWorkspaceRoot } from "../paths.js";

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
  const supervised = input.launchMode === "supervised";
  const cursorMcpPolicy = normalizeCursorMcpPolicy(input.cursorMcpPolicy);
  const requestedPermissionProfileId = normalizeRequestedPermissionProfileId(input.permissionProfileId);
  const permissionProfile = managedAgentPermissionProfileForProvider(
    "cursor",
    requestedPermissionProfileId ?? (supervised ? "sandboxed_write" : null),
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
  if (supervised || launchOptions.force || launchOptions.sandbox) {
    const flagResult = await execFileWithTimeout(command, ["--help"], {
      cwd: workspaceRoot ?? undefined,
      timeoutMs,
    });
    if (!flagResult.ok || !cursorHelpSupportsLaunchOptions(flagResult, launchOptions, supervised)) {
      return {
        providerId: provider.id,
        status: "error",
        canStart: false,
        message: "Cursor Agent does not support the selected permission profile.",
        detail: supervised
          ? "Update Cursor Agent so supervised Cursor can use --trust and the selected permission flags."
          : "Update Cursor Agent so managed Cursor can use the required --force and --sandbox flags.",
        nextAction: null,
        version,
        mcpStatus,
      };
    }
  }
  let managedProfile: CursorManagedProfile;
  let supervisedMcpRuntime: LetAgentsMcpRuntime | undefined;
  const preflightProfileRoot = supervised && workspaceRoot
    ? mkdtempSync(join(tmpdir(), "letagents-cursor-preflight-"))
    : null;
  const cleanupPreflightProfile = () => {
    if (preflightProfileRoot) rmSync(preflightProfileRoot, { recursive: true, force: true });
  };
  try {
    try {
      supervisedMcpRuntime = supervised && workspaceRoot
        ? options.mcpRuntime ?? resolveLetAgentsMcpRuntime({
          devEntryPath: process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL?.trim()
            ? join(sourceWorkspaceRoot, "dist", "mcp", "server.js")
            : undefined,
        })
        : undefined;
      managedProfile = supervised && workspaceRoot
        ? prepareCursorSupervisedProfile({
          workAttemptId: `preflight:${workspaceRoot}`,
          apiBaseUrl: desktopApiUrl,
          workspaceRoot,
          profileRoot: preflightProfileRoot!,
          mcpRuntime: supervisedMcpRuntime,
          identityAttestationOnly: true,
          inspectionOnly: true,
          mcpWorkingDirectory: preflightProfileRoot!,
        })
        : prepareCursorManagedProfile({
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
    let managedEnv = buildCursorChildEnv(managedProfile.env);
    if (supervised) {
      delete managedEnv.CURSOR_API_KEY;
      delete managedEnv.CURSOR_AUTH_TOKEN;
    }
    let attestedPersonalIdentity: Awaited<ReturnType<typeof assertCursorPersonalIdentity>> | undefined;
    if (supervised) {
      try {
        attestedPersonalIdentity = await (options.personalIdentityAttestor ?? assertCursorPersonalIdentity)({
          cursorBin: command,
          cwd: preflightProfileRoot!,
          env: managedEnv,
          writableProfileRoot: preflightProfileRoot!,
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
          message: "Cursor live account identity could not be supervised.",
          detail: error instanceof Error ? error.message : String(error),
          nextAction: null,
          version,
          mcpStatus,
        };
      }
    } else {
      const authResult = await execFileWithTimeout(command, ["status"], {
        cwd: workspaceRoot ?? undefined,
        env: managedEnv,
        timeoutMs,
      });
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

    if (supervised && (permissionProfile.id === "sandboxed_write" || permissionProfile.id === "full_access")) {
      try {
        await (options.workspaceGenerationSupportChecker ?? assertSupervisedWorkspaceGenerationSupported)(workspaceRoot);
      } catch (error) {
        return {
          providerId: provider.id,
          status: "error",
          canStart: false,
          message: "Cursor writable workspace cannot be supervised exactly.",
          detail: error instanceof Error ? error.message : String(error),
          nextAction: null,
          version,
          mcpStatus,
        };
      }
    }

    const resealAuthenticatedSupervisedProfile = async (): Promise<DesktopAgentProviderPreflight | null> => {
      if (!supervised || !preflightProfileRoot || !supervisedMcpRuntime) return null;
      try {
        managedProfile = prepareCursorSupervisedProfile({
          workAttemptId: `preflight:${workspaceRoot}`,
          apiBaseUrl: desktopApiUrl,
          workspaceRoot,
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
          message: "Cursor authenticated profile cannot be supervised exactly.",
          detail: error instanceof Error ? error.message : String(error),
          nextAction: null,
          version,
          mcpStatus,
        };
      }
    };
    const postAuthProfileError = await resealAuthenticatedSupervisedProfile();
    if (postAuthProfileError) return postAuthProfileError;

    if (supervised && preflightProfileRoot && supervisedMcpRuntime) {
      // Prove both the hidden project-config suppression flag and the exact
      // packaged bridge from a fresh credentialless profile. The authority
      // wrapper denies network and confines reads, writes, and process exec;
      // never run Cursor's side-effectful `mcp list` against an authenticated
      // profile merely to render a preflight screen.
      const authorityProfileRoot = join(preflightProfileRoot, "authority");
      try {
        const authorityProfile = prepareCursorSupervisedProfile({
          workAttemptId: `preflight-authority:${workspaceRoot}`,
          apiBaseUrl: desktopApiUrl,
          workspaceRoot,
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
          message: "Cursor supervised MCP authority is not exact.",
          detail,
          nextAction: null,
          version,
          mcpStatus,
        };
      }
    }

    if (!supervised && cursorMcpPolicy !== "normal") {
      // Supervised launches exercise project isolation only inside the two
      // credentialless, sandboxed authority attestations immediately before
      // each turn. An authenticated `mcp list` is unsafe here: Cursor loads
      // account-managed plugin and team MCP definitions while merely listing.
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
      message: `Cursor Agent is ready to start${supervised ? " supervised" : ""} with ${
        supervised && permissionProfile.id === "sandboxed_write"
          ? "Workspace writes"
          : supervised && permissionProfile.id === "full_access"
            ? "Workspace writes (compatibility)"
            : permissionProfile.label
      }.`,
      detail: cursorPreflightReadyDetail(cursorMcpPolicy, mcpStatus, permissionProfile.id, supervised),
      nextAction: null,
      version,
      mcpStatus,
    };
  } finally {
    cleanupPreflightProfile();
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
  supervised: boolean,
): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  return (!launchOptions.force || output.includes("--force")) &&
    (!(launchOptions.sandbox || supervised) || output.includes("--sandbox")) &&
    (!supervised || output.includes("--trust"));
}

function cursorPreflightReadyDetail(
  policy: ReturnType<typeof normalizeCursorMcpPolicy>,
  mcpStatus: DesktopMcpInstallTarget["status"] | null,
  permissionProfileId: Parameters<typeof cursorPermissionProfileReadyDetail>[0],
  supervised: boolean,
): string {
  const permissionDetail = cursorPermissionProfileReadyDetail(permissionProfileId, supervised);
  if (supervised) {
    return `${permissionDetail} A per-agent Cursor profile exposes only the daemon-mediated LetAgents bridge and survives desktop restarts.`;
  }
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

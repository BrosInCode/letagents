// Supervised (daemon-inbox) turn preparation: MCP inspection and bridge attestation,
// live identity attestation, the optional writable workspace generation, and the
// sealed per-turn profile, sandbox lists, and wrapper-hosted MCP environment.

import { withReadOnlyImageFolders } from "../cursor-room-turn-images.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CURSOR_IDENTITY_ATTESTATION_TIMEOUT_MS, CURSOR_MCP_CONNECTOR_PARENT, CURSOR_REAL_MCP_VALIDATION_TIMEOUT_MS } from "../cursor-provider-constants.js";
import {
  cursorSandboxPathVariants,
  cursorSandboxPathWithToolchains,
  cursorSandboxSdkRoot,
  cursorSandboxToolchainBinPaths,
  prepareCursorTurnRuntimeDataDir,
  removeCursorTurnRuntimeDataDir,
} from "../cursor-sandbox-policy.js";
import type { CursorSupervisedProfileOptions } from "./managed-profile.js";
import { cursorMcpInspectionEnv } from "../cursor-mcp-authority.js";
import { buildCursorChildEnv, cursorDaemonChildEnv } from "../cursor-runner.js";
import { managedCommitEnvironmentFor } from "../managed-agent-commit-identity.js";
import type { SupervisedWorkspaceGenerationHandle } from "../supervised-workspace-generation.js";
import { CursorProviderHandle, CursorRoomTurnNotDispatchedError } from "./lane-state.js";
import {
  cursorPermissionUsesWorkspaceGeneration,
  cursorSupervisorMcpEnv,
  usesExactScratchWorkspace,
} from "./launch-arguments.js";
import type { CursorProviderAdapter } from "./provider-adapter.js";

export function throwIfCursorTurnLaunchAborted(signal?: AbortSignal, roomTurnId?: string | null): void {
  if (signal?.aborted) {
    throw new CursorRoomTurnNotDispatchedError(
      "Cursor turn preparation was interrupted before native dispatch.",
      roomTurnId,
    );
  }
}

/** Everything the daemon-inbox preparation decides for one native launch. */
export interface SupervisedTurnPreparation {
  childEnv: NodeJS.ProcessEnv | undefined;
  deniedReadPaths: string[] | undefined;
  deniedReadSubpaths: string[] | undefined;
  deniedReadMetadataPaths: string[] | undefined;
  deniedReadWriteRegexes: string[] | undefined;
  deniedWriteRegexes: string[] | undefined;
  deniedWritePaths: string[] | undefined;
  deniedWriteStructuralPaths: string[] | undefined;
  deniedWriteSubpaths: string[] | undefined;
  deniedExecSubpaths: string[] | undefined;
  allowedWriteSubpaths: string[] | undefined;
  allowedReadSubpaths: string[] | undefined;
  mcpConnectorRoot: string | undefined;
  mcpConnectorSocketPath: string | undefined;
  mcpRuntimeEntryPath: string | undefined;
  mcpRuntimeEnv: Readonly<Record<string, string>> | undefined;
  providerAuthorization: string | undefined;
  supervisedRuntimeDataDir: string | undefined;
  workspaceGeneration: SupervisedWorkspaceGenerationHandle | null;
  providerWorkspace: string;
}

export async function prepareSupervisedTurn(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
  roomTurnId: string | null,
  launchSignal: AbortSignal | undefined,
  readOnlyImageFolders: readonly string[],
  exactWorkspaceOnly: boolean,
  apiBaseUrl: string,
): Promise<SupervisedTurnPreparation> {
  let childEnv: NodeJS.ProcessEnv | undefined;
  let deniedReadPaths: string[] | undefined;
  let deniedReadSubpaths: string[] | undefined;
  let deniedReadMetadataPaths: string[] | undefined;
  let deniedReadWriteRegexes: string[] | undefined;
  let deniedWriteRegexes: string[] | undefined;
  let deniedWritePaths: string[] | undefined;
  let deniedWriteStructuralPaths: string[] | undefined;
  let deniedWriteSubpaths: string[] | undefined;
  let deniedExecSubpaths: string[] | undefined;
  let allowedWriteSubpaths: string[] | undefined;
  let allowedReadSubpaths: string[] | undefined;
  let mcpConnectorRoot: string | undefined;
  let mcpConnectorSocketPath: string | undefined;
  let mcpRuntimeEntryPath: string | undefined;
  let mcpRuntimeEnv: Readonly<Record<string, string>> | undefined;
  let providerAuthorization: string | undefined;
  let supervisedRuntimeDataDir: string | undefined;
  let workspaceGeneration: SupervisedWorkspaceGenerationHandle | null = null;
  let providerWorkspace = handle.cwd;
  // First enumerate from a random disposable profile with an inert local
  // MCP and no turn/provider capability. The authority wrapper denies
  // direct networking and confines readable data/process execution.
  const inspectionProfileRoot = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-inspection-"));
  try {
    const enumerationProfile = adapter.supervisedProfileFactory({
      apiBaseUrl,
      workAttemptId: `${handle.workAttemptId}:mcp-inspection:${randomUUID()}`,
      cwd: handle.cwd,
      profileRoot: inspectionProfileRoot,
      includeAuth: false,
      inspectionOnly: true,
      exactWorkspaceOnly,
      devMcpServerEntryPath: handle.spawnRequest.devMcpServerEntryPath,
    });
    const enumerationEnv = cursorMcpInspectionEnv({
      ...buildCursorChildEnv(enumerationProfile.env),
      AGENT_CLI_CREDENTIAL_STORE: "file",
    });
    await adapter.deps.attestSupervisedMcp({
      cursorBin: adapter.cursorBin,
      cwd: inspectionProfileRoot,
      env: enumerationEnv,
      writableProfileRoot: inspectionProfileRoot,
      expectedServerName: enumerationProfile.mcpServerName,
      signal: launchSignal,
    });
  } catch (error) {
    if (launchSignal?.aborted) {
      throw new CursorRoomTurnNotDispatchedError(
        "Cursor MCP attestation was interrupted and reaped before native dispatch.",
        roomTurnId,
      );
    }
    throw error;
  } finally {
    rmSync(inspectionProfileRoot, { recursive: true, force: true });
  }
  throwIfCursorTurnLaunchAborted(launchSignal, roomTurnId);

  // Pass one can only write its own now-deleted root. Create pass two
  // afterward so an escaped pass-one descendant never had path authority
  // over the profile that exercises the packaged bridge.
  const bridgeProfileRoot = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-bridge-"));
  try {
    const bridgeProfile = adapter.supervisedProfileFactory({
      apiBaseUrl,
      workAttemptId: `${handle.workAttemptId}:mcp-bridge:${randomUUID()}`,
      cwd: handle.cwd,
      profileRoot: bridgeProfileRoot,
      includeAuth: false,
      inspectionOnly: false,
      exactWorkspaceOnly,
      devMcpServerEntryPath: handle.spawnRequest.devMcpServerEntryPath,
      mcpWorkingDirectory: bridgeProfileRoot,
      // Exercise the packaged server in its real credentialless bounded
      // mode. Owner mode would attempt repository auto-join after stdio
      // connect and can fail for reasons unrelated to MCP readiness. The
      // inspection never invokes a tool and its network sandbox admits no
      // supervisor socket, so these two non-secret mode markers cannot
      // borrow or exercise turn authority.
      supervisorMcpEnv: {
        LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
        LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
        LETAGENTS_SUPERVISOR_PROVIDER: "cursor",
      },
    });
    const bridgeEnv = cursorMcpInspectionEnv({
      ...buildCursorChildEnv(bridgeProfile.env),
      // Prevent Cursor's shell launcher from consulting the login keychain
      // while validating a credentialless, local packaged bridge.
      AGENT_CLI_CREDENTIAL_STORE: "file",
    });
    await adapter.deps.attestSupervisedMcp({
      cursorBin: adapter.cursorBin,
      cwd: bridgeProfileRoot,
      env: bridgeEnv,
      writableProfileRoot: bridgeProfileRoot,
      requiredReadableRoots: bridgeProfile.mcpRuntimeReadRoots,
      expectedServerName: bridgeProfile.mcpServerName,
      timeoutMs: CURSOR_REAL_MCP_VALIDATION_TIMEOUT_MS,
      signal: launchSignal,
    });
  } catch (error) {
    if (supervisedRuntimeDataDir) {
      removeCursorTurnRuntimeDataDir(supervisedRuntimeDataDir);
      supervisedRuntimeDataDir = undefined;
    }
    if (launchSignal?.aborted) {
      throw new CursorRoomTurnNotDispatchedError(
        "Cursor MCP attestation was interrupted and reaped before native dispatch.",
        roomTurnId,
      );
    }
    throw error;
  } finally {
    rmSync(bridgeProfileRoot, { recursive: true, force: true });
  }
  throwIfCursorTurnLaunchAborted(launchSignal, roomTurnId);
  // Prove the live credential-store identity immediately before every
  // dispatch. Cursor's cached authInfo can lag account/team membership and
  // ambient API credentials are deliberately scrubbed, so a fresh random
  // profile runs only `status --format json`, requires real userInfo, and
  // fails closed for team-managed identities. The attested auth-only files
  // then overwrite stale metadata in the stable attempt profile.
  const identityProfileRoot = mkdtempSync(join(tmpdir(), "letagents-cursor-identity-"));
  try {
    let identityProfile = adapter.supervisedProfileFactory({
      apiBaseUrl,
      workAttemptId: `${handle.workAttemptId}:identity:${randomUUID()}`,
      cwd: handle.cwd,
      profileRoot: identityProfileRoot,
      includeAuth: true,
      identityAttestationOnly: true,
      inspectionOnly: true,
      exactWorkspaceOnly,
      devMcpServerEntryPath: handle.spawnRequest.devMcpServerEntryPath,
      mcpWorkingDirectory: identityProfileRoot,
    });
    const personalIdentity = await adapter.deps.attestPersonalIdentity({
      cursorBin: adapter.cursorBin,
      cwd: identityProfileRoot,
      env: cursorDaemonChildEnv(identityProfile.env),
      writableProfileRoot: identityProfileRoot,
      requiredReadableRoots: identityProfile.authReadRoots,
      timeoutMs: CURSOR_IDENTITY_ATTESTATION_TIMEOUT_MS,
      signal: launchSignal,
    });
    providerAuthorization = personalIdentity.providerAuthorization;
    if (!providerAuthorization) {
      throw new Error("Cursor live identity attestation returned no provider authorization proof.");
    }
    // Reseal after status so any refreshed teamId is checked before its
    // sanitized auth metadata becomes the final turn's source.
    identityProfile = adapter.supervisedProfileFactory({
      apiBaseUrl,
      workAttemptId: `${handle.workAttemptId}:identity:resealed`,
      cwd: handle.cwd,
      profileRoot: identityProfileRoot,
      includeAuth: true,
      authSourceHomeDir: identityProfile.homeDir,
      attestedPersonalIdentity: personalIdentity,
      exposeLoginCredentials: false,
      inspectionOnly: true,
      exactWorkspaceOnly,
      devMcpServerEntryPath: handle.spawnRequest.devMcpServerEntryPath,
      mcpWorkingDirectory: identityProfileRoot,
    });
    throwIfCursorTurnLaunchAborted(launchSignal, roomTurnId);

    // Only after both credentialless probes are removed and live identity
    // is proven do we atomically reseal the stable profile and mint the
    // real MCP child's exact turn capability.
    // Scratch attempts already run in a disposable room-only workspace. A
    // Git-backed generation here would fail: the workspace's own
    // repository is empty and has no commit to pin.
    if (
      roomTurnId
      && cursorPermissionUsesWorkspaceGeneration(handle.spawnRequest.permissionProfileId)
      && !usesExactScratchWorkspace(handle.spawnRequest)
    ) {
      workspaceGeneration = await adapter.deps.createWorkspaceGeneration({
        realWorkspace: handle.cwd,
        turnIdentity: roomTurnId,
      });
    }
    providerWorkspace = workspaceGeneration?.liveWorkspace ?? handle.cwd;
    const supervisorMcpEnv = cursorSupervisorMcpEnv(handle.spawnRequest, roomTurnId);
    mcpConnectorRoot = join(CURSOR_MCP_CONNECTOR_PARENT, `letagents-cursor-mcp-${randomUUID()}`);
    mcpConnectorSocketPath = join(mcpConnectorRoot, "stdio.sock");
    const profile = adapter.supervisedProfileFactory({
      apiBaseUrl,
      workAttemptId: handle.workAttemptId,
      cwd: providerWorkspace,
      permissionProfileId: handle.spawnRequest.permissionProfileId as CursorSupervisedProfileOptions["permissionProfileId"],
      exactWorkspaceOnly,
      authSourceHomeDir: identityProfile.homeDir,
      attestedPersonalIdentity: personalIdentity,
      exposeLoginCredentials: false,
      devMcpServerEntryPath: handle.spawnRequest.devMcpServerEntryPath,
      mcpConnectorSocketPath,
    });
    adapter.deps.bindPersonalIdentity(profile, personalIdentity);
    childEnv = cursorDaemonChildEnv(
      profile.env,
      await managedCommitEnvironmentFor(handle.spawnRequest),
      handle.spawnRequest.permissionProfileId === "full_access",
    );
    const toolchainPath = cursorSandboxToolchainBinPaths();
    if (toolchainPath.length > 0) {
      // Apple's /usr/bin compiler drivers are xcrun shims, which require
      // host temp/cache writes. Prefer the real selected compiler bins so
      // ordinary repo builds work without widening the repo-only fence.
      childEnv.PATH = cursorSandboxPathWithToolchains(childEnv.PATH ?? "", toolchainPath);
    }
    const sdkRoot = cursorSandboxSdkRoot();
    if (sdkRoot) childEnv.SDKROOT = sdkRoot;
    // Cursor's long stable Application Support path otherwise falls back
    // to the shared /tmp/.cursor worker socket. A new unpredictable short
    // root per turn prevents both ambient-worker reuse and a detached old
    // helper from colliding with the next resumed turn.
    supervisedRuntimeDataDir = prepareCursorTurnRuntimeDataDir();
    childEnv.CURSOR_DATA_DIR = supervisedRuntimeDataDir;
    // Cursor's installed launcher adds `--use-system-ca` for memory/Keychain
    // stores, which makes Node enumerate the user's macOS Keychain. The
    // file store is confined to this owner-private profile; Cursor writes
    // only our public argv placeholder and the wrapper removes it before
    // publishing terminal evidence.
    childEnv.AGENT_CLI_CREDENTIAL_STORE = "file";
    deniedReadPaths = profile.nativeDeniedReadPaths;
    deniedReadSubpaths = profile.nativeDeniedReadSubpaths;
    deniedReadMetadataPaths = profile.nativeDeniedReadMetadataPaths;
    deniedReadWriteRegexes = profile.nativeDeniedReadWriteRegexes;
    deniedWriteRegexes = profile.nativeDeniedWriteRegexes;
    deniedWritePaths = profile.nativeDeniedWritePaths;
    deniedWriteStructuralPaths = profile.nativeDeniedWriteStructuralPaths;
    deniedWriteSubpaths = withReadOnlyImageFolders(profile.nativeDeniedWriteSubpaths, readOnlyImageFolders);
    deniedExecSubpaths = profile.nativeDeniedExecSubpaths;
    allowedWriteSubpaths = profile.nativeAllowedWriteSubpaths?.length
      ? [...new Set([
        ...profile.nativeAllowedWriteSubpaths,
        ...cursorSandboxPathVariants(supervisedRuntimeDataDir),
      ])]
      : undefined;
    allowedReadSubpaths = profile.nativeAllowedReadSubpaths?.length
      ? [...new Set([
        ...profile.nativeAllowedReadSubpaths,
        ...cursorSandboxPathVariants(supervisedRuntimeDataDir),
        ...(workspaceGeneration?.readOnlyRoots.flatMap((entry) => [
          ...cursorSandboxPathVariants(entry.sourcePath),
          ...(entry.generationPath ? cursorSandboxPathVariants(entry.generationPath) : []),
        ]) ?? []),
        ...readOnlyImageFolders.flatMap(cursorSandboxPathVariants),
      ])]
      : undefined;
    deniedExecSubpaths = [...new Set([
      ...(deniedExecSubpaths ?? []),
      ...cursorSandboxPathVariants(supervisedRuntimeDataDir),
      ...readOnlyImageFolders.flatMap(cursorSandboxPathVariants),
    ])];
    mcpRuntimeEntryPath = profile.mcpRuntimeEntryPath;
    if (!profile.mcpRuntimeEnv) {
      throw new Error("Supervised Cursor's wrapper-hosted MCP environment is unavailable.");
    }
    const mcpRuntimeRoot = dirname(mcpConnectorSocketPath);
    mcpRuntimeEnv = {
      ELECTRON_RUN_AS_NODE: "1",
      LETAGENTS_API_URL: profile.mcpRuntimeEnv.LETAGENTS_API_URL,
      HOME: join(mcpRuntimeRoot, "home"),
      XDG_CONFIG_HOME: join(mcpRuntimeRoot, "config"),
      XDG_DATA_HOME: join(mcpRuntimeRoot, "data"),
      XDG_CACHE_HOME: join(mcpRuntimeRoot, "cache"),
      CURSOR_CONFIG_DIR: join(mcpRuntimeRoot, "config", "cursor"),
      CURSOR_DATA_DIR: join(mcpRuntimeRoot, "data", "cursor"),
      NODE_COMPILE_CACHE: join(mcpRuntimeRoot, "cache", "node-compile-cache"),
      CURSOR_API_KEY: "",
      CURSOR_AUTH_TOKEN: "",
      ...supervisorMcpEnv,
    };
  } catch (error) {
    if (workspaceGeneration) {
      await adapter.abandonTurnWorkspaceGeneration(workspaceGeneration);
      workspaceGeneration = null;
    }
    if (launchSignal?.aborted) {
      throw new CursorRoomTurnNotDispatchedError(
        "Cursor identity attestation was interrupted before native dispatch.",
        roomTurnId,
      );
    }
    throw error;
  } finally {
    rmSync(identityProfileRoot, { recursive: true, force: true });
  }
  return {
    childEnv,
    deniedReadPaths,
    deniedReadSubpaths,
    deniedReadMetadataPaths,
    deniedReadWriteRegexes,
    deniedWriteRegexes,
    deniedWritePaths,
    deniedWriteStructuralPaths,
    deniedWriteSubpaths,
    deniedExecSubpaths,
    allowedWriteSubpaths,
    allowedReadSubpaths,
    mcpConnectorRoot,
    mcpConnectorSocketPath,
    mcpRuntimeEntryPath,
    mcpRuntimeEnv,
    providerAuthorization,
    supervisedRuntimeDataDir,
    workspaceGeneration,
    providerWorkspace,
  };
}

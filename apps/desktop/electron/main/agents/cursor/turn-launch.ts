// Lane start and native turn launch: preparation, durable checkpoints, release, and init gating.

import { withReadOnlyImageFolders } from "../cursor-room-turn-images.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildCodexStartPrompt,
  DEFAULT_CODEX_STOP_PHRASE,
  looksLikeInviteCode,
  makeCodexStopToken,
} from "../codex-start-prompt.js";
import type { ProviderContinuationRef, ProviderRoomTurnOptions, ProviderSpawnRequest } from "../provider-adapter.js";
import { CURSOR_IDENTITY_ATTESTATION_TIMEOUT_MS, CURSOR_MCP_CONNECTOR_PARENT, CURSOR_REAL_MCP_VALIDATION_TIMEOUT_MS } from "../cursor-provider-constants.js";
import { safeCursorTerminalErrorDetail } from "../cursor-provider-evidence.js";
import { CursorRoomTurnRecoveryError } from "../cursor-turn-settlement.js";
import {
  cursorSandboxPathVariants,
  cursorSandboxPathWithToolchains,
  cursorSandboxSdkRoot,
  cursorSandboxToolchainBinPaths,
  prepareCursorTurnRuntimeDataDir,
  removeCursorTurnRuntimeDataDir,
} from "../cursor-sandbox-policy.js";
import type { CursorCliChild } from "../cursor-turn-launcher.js";
import { attestProviderSpawnPolicy } from "../provider-spawn-configuration.js";
import type { ProviderProcessExit } from "../provider-evidence.js";
import { apiUrl as desktopApiUrl } from "../../paths.js";
import type { CursorManagedProfile, CursorSupervisedProfileOptions } from "../cursor-managed-profile.js";
import { cursorMcpInspectionEnv } from "../cursor-mcp-authority.js";
import { buildCursorChildEnv, cursorDaemonChildEnv } from "../cursor-runner.js";
import { managedCommitEnvironmentFor } from "../managed-agent-commit-identity.js";
import type { SupervisedWorkspaceGenerationHandle } from "../supervised-workspace-generation.js";
import type { CursorProviderAdapter } from "../cursor-provider-adapter.js";
import {
  CursorPostDispatchCheckpointError,
  CursorProviderHandle,
  CursorRoomTurnNotDispatchedError,
  type CursorTurnTerminal,
  type LiveTurn,
} from "./lane-state.js";
import {
  CURSOR_PENDING_CONTINUATION_PREFIX,
  cursorLaunchPolicyArgs,
  cursorPermissionUsesWorkspaceGeneration,
  cursorSupervisorMcpEnv,
  requireCursorSessionId,
  usesExactScratchWorkspace,
} from "./launch-arguments.js";

function throwIfCursorTurnLaunchAborted(signal?: AbortSignal, roomTurnId?: string | null): void {
  if (signal?.aborted) {
    throw new CursorRoomTurnNotDispatchedError(
      "Cursor turn preparation was interrupted before native dispatch.",
      roomTurnId,
    );
  }
}

function cursorTurnLaunchAbort(signal?: AbortSignal): Promise<"aborted"> {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
}

export async function start(
  adapter: CursorProviderAdapter,
  req: ProviderSpawnRequest,
  resumeRef: ProviderContinuationRef | null,
): Promise<CursorProviderHandle> {
  const current = adapter.handles.get(req.workAttemptId);
  if (current && !current.terminal) {
    throw new Error(`Cursor work attempt '${req.workAttemptId}' already has a live lane.`);
  }
  if (!req.agentDisplayName?.trim()) {
    throw new Error("Cursor spawn requires the durable agent display name from the manifest.");
  }
  const deliveryMode = req.deliveryMode ?? "mcp_polling";
  if (deliveryMode !== "mcp_polling" && deliveryMode !== "daemon_inbox") {
    throw new Error(`Cursor does not support ${deliveryMode} room delivery.`);
  }
  if (deliveryMode === "daemon_inbox" && !req.permissionProfileId?.trim()) {
    throw new Error("Cursor daemon-inbox launch requires an exact permission profile.");
  }
  if (deliveryMode === "daemon_inbox"
    && req.workspaceKind !== "git_worktree"
    && req.workspaceKind !== "room_scratch") {
    throw new Error("Cursor daemon-inbox launch requires an explicit workspace kind.");
  }
  const policyArgs = [
    ...cursorLaunchPolicyArgs(attestProviderSpawnPolicy("cursor", req)),
    ...(req.model ? ["--model", req.model] : []),
  ];
  let supervisedProfile: CursorManagedProfile | null = null;
  if (deliveryMode === "daemon_inbox") {
    if (!req.supervisorEntryId?.trim()
      || !req.supervisorSocketPath?.trim()
      || !req.supervisorExecutionGenerationId?.trim()) {
      throw new Error("Cursor daemon-inbox launch requires exact supervisor coordinates.");
    }
    supervisedProfile = adapter.supervisedProfileFactory({
      workAttemptId: req.workAttemptId,
      cwd: req.cwd,
      apiBaseUrl: req.supervisorWorkerSession?.apiUrl ?? desktopApiUrl,
      permissionProfileId: req.permissionProfileId as CursorSupervisedProfileOptions["permissionProfileId"],
      exactWorkspaceOnly: usesExactScratchWorkspace(req),
      includeAuth: false,
      devMcpServerEntryPath: req.devMcpServerEntryPath,
    });
  }
  const handle = new CursorProviderHandle(
    req.workAttemptId,
    req.cwd,
    policyArgs,
    deliveryMode,
    req,
    supervisedProfile,
    adapter.deps.now,
  );
  if (resumeRef) handle.providerContinuationId = resumeRef.providerContinuationId;

  // A daemon successor must not start a bootstrap turn while an uncheckpointed
  // predecessor child may still be finishing. The durable FIFO recovers (or
  // blocks) that exact turn first; a later real inbox item verifies --resume.
  if (deliveryMode === "daemon_inbox") {
    // Cursor cannot mint a session without executing an inference. Persist a
    // non-native placeholder and let the FIRST DURABLY JOURNALED inbox turn
    // establish the real session instead of running uncaused bootstrap work.
    if (!handle.providerContinuationId) {
      handle.providerContinuationId = `${CURSOR_PENDING_CONTINUATION_PREFIX}${randomUUID()}`;
    }
    handle.state = "idle";
    adapter.handles.set(req.workAttemptId, handle);
    return handle;
  }

  const prompt = buildCodexStartPrompt({
    roomIdentifier: req.roomId,
    joinedVia: looksLikeInviteCode(req.roomId) ? "join_code" : "join_room",
    cwd: req.cwd,
    stopPhrase: DEFAULT_CODEX_STOP_PHRASE,
    token: makeCodexStopToken(),
    suggestedDisplayName: req.agentDisplayName.trim(),
    deadlineUtc: null,
    maxMinutes: 0,
    providerLabel: "Cursor",
    runtimeKey: "cursor",
  });

  adapter.handles.set(req.workAttemptId, handle);
  try {
    await adapter.beginTurn(handle, prompt, resumeRef?.providerContinuationId ?? null);
    return handle;
  } catch (error) {
    if (adapter.handles.get(req.workAttemptId) === handle) {
      adapter.handles.delete(req.workAttemptId);
    }
    throw error;
  }
}

/**
 * Launch one native turn and resolve once it has STARTED (identity verified
 * and the first stream event observed). The room-worker turn then runs
 * arbitrarily long; completion is handled asynchronously by completeTurn —
 * spawn/poke callers get their handle back immediately, exactly like the
 * long-lived adapters.
 */
export async function beginTurn(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
  prompt: string,
  resumeSessionId: string | null,
  roomTurnId: string | null = null,
  checkpointProviderState?: ProviderRoomTurnOptions["checkpointProviderState"],
  checkpointTurnStarted?: ProviderRoomTurnOptions["checkpointTurnStarted"],
  checkpointPreparedTurn?: ProviderRoomTurnOptions["checkpointPreparedTurn"],
  launchSignal?: AbortSignal,
  markDurableTurnStarted?: ProviderRoomTurnOptions["markDurableTurnStarted"],
  settleLifecycleBeforeIdle?: ProviderRoomTurnOptions["settleLifecycleBeforeIdle"],
  readOnlyImageFolders: readonly string[] = [], // Daemon-staged images: this launch may read, never write or run.
): Promise<LiveTurn> {
  return adapter.processCustody.acquire(handle.workAttemptId, async () => {
    throwIfCursorTurnLaunchAborted(launchSignal, roomTurnId);
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
    const exactWorkspaceOnly = usesExactScratchWorkspace(handle.spawnRequest);
    const apiBaseUrl = handle.spawnRequest.supervisorWorkerSession?.apiUrl ?? desktopApiUrl;
    if (handle.deliveryMode === "daemon_inbox") {
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
    }
    const nativeResumeSession = resumeSessionId?.startsWith(CURSOR_PENDING_CONTINUATION_PREFIX)
      ? null
      : resumeSessionId
        ? requireCursorSessionId(resumeSessionId, "Cursor resume session")
        : null;
    const args = [
      "-p",
      "--output-format", "stream-json",
      // Cursor otherwise merges every .cursor/cli.json from the Git root down
      // to --workspace after our static check. Keep the provider's own native
      // suppression in addition to the per-turn filesystem revalidation.
      ...(handle.deliveryMode === "daemon_inbox" ? ["--disable-project-configs"] : []),
      ...(handle.deliveryMode === "daemon_inbox" ? ["--disable-auto-update"] : []),
      // cursor-agent has no headless per-server MCP approval (Cursor confirms
      // it is unimplemented); --approve-mcps is the ONLY non-interactive way to
      // load an MCP server. Without it the sealed HOME letagents MCP never
      // loads, so complete_room_turn is never exposed and the turn can never
      // attest (its "did not attest ... before model authority" timeout). This
      // Restricted profiles keep the sealed HOME as the sole MCP surface:
      // its mcp.json holds only the letagents server, and the outer sandbox
      // denies reads of workspace .cursor/mcp.json (see
      // SUPERVISED_CURSOR_PROJECT_HIDDEN_AUTHORITY_FILES -> nativeDeniedReadPaths),
      // so a checked-in or concurrently-added project server cannot be read,
      // let alone approved. Full access intentionally removes that boundary.
      ...(handle.deliveryMode === "daemon_inbox" ? ["--approve-mcps"] : []),
      "--trust",
      // Read-only has no native sandbox field in its durable policy, so add
      // the supervised outer boundary explicitly. Write profiles carry their
      // exact enabled/disabled native choice in policyArgs. Only restricted
      // profiles also use the independent OS workspace/process/network boundary.
      ...(handle.deliveryMode === "daemon_inbox" && handle.spawnRequest.permissionProfileId === "read_only"
        ? ["--sandbox", "enabled"]
        : []),
      "--workspace", providerWorkspace,
      ...handle.policyArgs,
      ...(nativeResumeSession ? [`--resume=${nativeResumeSession}`] : []),
      prompt,
    ];
    const statePath = roomTurnId && handle.supervisedProfile
      ? join(
        handle.supervisedProfile.configDir,
        `letagents-cursor-turn-${createHash("sha256").update(roomTurnId).digest("hex")}.jsonl`,
      )
      : null;
    if (statePath) {
      adapter.deps.prepareTurnState(statePath);
    }
    let child: CursorCliChild;
    try {
      child = adapter.deps.launchTurn({
      cursorBin: adapter.cursorBin,
      args,
      // Start inside the sealed private profile so no ambient launch cwd can
      // contribute config before Cursor resolves --workspace. Cursor later
      // changes into that workspace and can discover a concurrently-added
      // project MCP; restricted profiles use the unpredictable bridge alias,
      // approval-state purge, and sandbox denial of workspace .cursor/mcp.json to keep
      // such a late server unreadable, so --approve-mcps (above) can only ever
      // approve the sealed HOME letagents server. Full access permits host
      // configuration reads and does not claim this isolation guarantee.
      cwd: handle.deliveryMode === "daemon_inbox" && handle.supervisedProfile
        ? dirname(handle.supervisedProfile.homeDir)
        : handle.cwd,
      ...(childEnv ? { env: childEnv } : {}),
      ...(deniedReadPaths?.length ? { deniedReadPaths } : {}),
      ...(deniedReadSubpaths?.length ? { deniedReadSubpaths } : {}),
      ...(deniedReadMetadataPaths?.length ? { deniedReadMetadataPaths } : {}),
      ...(deniedReadWriteRegexes?.length ? { deniedReadWriteRegexes } : {}),
      ...(deniedWriteRegexes?.length ? { deniedWriteRegexes } : {}),
      ...(deniedWritePaths?.length ? { deniedWritePaths } : {}),
      ...(deniedWriteStructuralPaths?.length ? { deniedWriteStructuralPaths } : {}),
      ...(deniedWriteSubpaths?.length ? { deniedWriteSubpaths } : {}),
      ...(deniedExecSubpaths?.length ? { deniedExecSubpaths } : {}),
      ...(allowedWriteSubpaths?.length ? { allowedWriteSubpaths } : {}),
      ...(allowedReadSubpaths?.length ? { allowedReadSubpaths } : {}),
      ...(handle.deliveryMode === "daemon_inbox"
        ? {
          allowedNetworkUnixSockets: [mcpConnectorSocketPath!],
          // Cursor's headless worker binds a private stdio socket under this
          // per-turn data dir; the sandbox must admit that one bind+connect.
          allowedInternalUnixSocketRoots: [supervisedRuntimeDataDir!],
        }
        : {}),
      ...(mcpConnectorSocketPath ? { mcpConnectorSocketPath } : {}),
      ...(mcpRuntimeEntryPath ? { mcpRuntimeEntryPath } : {}),
      ...(handle.deliveryMode === "daemon_inbox" ? { mcpRuntimeCwd: providerWorkspace } : {}),
      ...(mcpRuntimeEnv ? { mcpRuntimeEnv } : {}),
      ...(providerAuthorization ? { providerAuthorization } : {}),
      ...(handle.deliveryMode === "daemon_inbox" ? { deferStart: true } : {}),
      ...(handle.deliveryMode === "daemon_inbox" ? { restrictRemoteAuthority: true } : {}),
      // Derive host access from the attested profile, never from CLI flags or
      // a prompt. Keep the wrapper's room bridge and recovery journal in both modes.
      ...(handle.deliveryMode === "daemon_inbox" && handle.spawnRequest.permissionProfileId === "full_access"
        ? { fullAccess: true }
        : {}),
      ...(handle.deliveryMode === "daemon_inbox" && nativeResumeSession
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeResumeSession)
        ? { nativeResumeSessionId: nativeResumeSession }
        : {}),
      ...(workspaceGeneration
        ? { workspaceGenerationManifestPath: workspaceGeneration.manifestPath }
        : {}),
      ...(statePath ? { statePath } : {}),
      });
    } catch (error) {
      if (supervisedRuntimeDataDir) removeCursorTurnRuntimeDataDir(supervisedRuntimeDataDir);
      if (workspaceGeneration) {
        await adapter.abandonTurnWorkspaceGeneration(workspaceGeneration);
        workspaceGeneration = null;
      }
      throw error;
    }
    const captureBirth = adapter.processCustody.record(handle.workAttemptId, child);
    if (supervisedRuntimeDataDir) {
      const runtimeDataDir = supervisedRuntimeDataDir;
      // The production wrapper removes this before terminal publication. This
      // post-exit fallback also retires it for injected/test launchers and a
      // wrapper that exits before entering its finalizer.
      void child.exited.then(() => {
        try { removeCursorTurnRuntimeDataDir(runtimeDataDir); } catch { /* terminal evidence remains authoritative */ }
      });
    }
    if (mcpConnectorRoot) {
      const connectorRoot = mcpConnectorRoot;
      // The wrapper normally retires this root before terminal evidence. If
      // the wrapper itself is SIGKILLed, the supervising adapter still owns
      // the unpredictable path and removes the now-dead socket tree on exit.
      void child.exited.then(() => {
        try { rmSync(connectorRoot, { recursive: true, force: true }); } catch { /* no live socket authority remains */ }
      });
    }
    const nativeLaunchIsDeferred = handle.deliveryMode === "daemon_inbox";
    let conversationLoanAttempted = false;
    const abandonPreparedGeneration = async (): Promise<void> => {
      if (!workspaceGeneration) return;
      if (!conversationLoanAttempted && !child.requiresDurableTerminalEvidence) {
        await adapter.abandonTurnWorkspaceGeneration(workspaceGeneration);
        workspaceGeneration = null;
        return;
      }
      adapter.restoreConversationNamespace(handle, workspaceGeneration);
      const receipt = await workspaceGeneration.abandon();
      if (receipt.phase !== "aborted") throw new CursorRoomTurnRecoveryError("Cursor preparation did not abandon its generation.");
      if (roomTurnId && child.requiresDurableTerminalEvidence) {
        adapter.recordGenerationSettlement(handle, roomTurnId, workspaceGeneration.manifestPath, "aborted");
      }
      await adapter.deps.removeWorkspaceGenerationReceipt(workspaceGeneration.manifestPath,
        { settlementVerified: child.requiresDurableTerminalEvidence === true });
      workspaceGeneration = null;
    };

    if (launchSignal?.aborted || handle.stopRequested) {
      if (child.pid !== null) {
        const wrapperIdentity = nativeLaunchIsDeferred ? adapter.deps.getProcessIdentity(child.pid) : undefined;
        await adapter.terminateTurnChild(child.pid, child.exited, wrapperIdentity, child.ownsDescendantReaping, nativeLaunchIsDeferred);
      } else {
        await child.exited;
      }
      await abandonPreparedGeneration();
      throw new CursorRoomTurnNotDispatchedError(
        "Cursor turn preparation was interrupted before native dispatch.",
        roomTurnId,
      );
    }

    if (child.pid === null) {
      // Fail closed until the launch proves terminal; never retry beside an
      // unobservable writer.
      await child.exited;
      await abandonPreparedGeneration();
      adapter.finishAttempt(handle, { type: "exit", code: null, signal: null }, "protocol_error");
      throw new Error("cursor-agent launch did not expose a process id; refusing an unfenceable turn.");
    }
    if (child.prepared) {
      let preparation: "prepared" | "exited" | "aborted";
      try {
        preparation = await Promise.race([
          child.prepared.then(() => "prepared" as const),
          child.exited.then(() => "exited" as const),
          cursorTurnLaunchAbort(launchSignal),
        ]);
      } catch (error) {
        await child.exited;
        await abandonPreparedGeneration();
        throw new Error(`Cursor wrapper could not prepare its durable boundary: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (preparation === "exited") {
        await abandonPreparedGeneration();
        throw new Error("Cursor wrapper exited before preparing its durable boundary; native work was not launched.");
      }
      if (preparation === "aborted") {
        const wrapperIdentity = nativeLaunchIsDeferred ? adapter.deps.getProcessIdentity(child.pid) : undefined;
        await adapter.terminateTurnChild(child.pid, child.exited, wrapperIdentity, child.ownsDescendantReaping, nativeLaunchIsDeferred);
        await abandonPreparedGeneration();
        throw new CursorRoomTurnNotDispatchedError(
          "Cursor turn preparation was interrupted before native dispatch.",
          roomTurnId,
        );
      }
    }
    const processIdentity = captureBirth();
    if (typeof processIdentity !== "string" || !processIdentity) {
      await adapter.terminateTurnChild(child.pid, child.exited, processIdentity, child.ownsDescendantReaping, nativeLaunchIsDeferred);
      await abandonPreparedGeneration();
      adapter.finishAttempt(handle, { type: "exit", code: null, signal: null }, "protocol_error");
      throw new Error("cursor-agent process identity could not be verified; refusing an unfenceable turn.");
    }
    if (launchSignal?.aborted || handle.stopRequested) {
      await adapter.terminateTurnChild(child.pid, child.exited, processIdentity, child.ownsDescendantReaping, nativeLaunchIsDeferred);
      await abandonPreparedGeneration();
      throw new CursorRoomTurnNotDispatchedError(
        "Cursor turn preparation was interrupted before native dispatch.",
        roomTurnId,
      );
    }

    const turn: LiveTurn = {
      child,
      pid: child.pid,
      processIdentity,
      sawInit: false,
      sawResult: false,
      resultWasError: false,
      resultText: null,
      providerRequestId: null,
      interruptRequested: false,
      roomTurnId,
      controlTurnId: roomTurnId ?? randomUUID(),
      statePath,
      workspaceGeneration,
      workspaceGenerationManifestPath: workspaceGeneration?.manifestPath ?? null,
      liveDisplayTools: new Map(),
      executionTools: new Map(),
      executionTurnFinished: false,
      executionRuntimeFinished: false,
      lifecycleSettlementDeferred: Boolean(roomTurnId && settleLifecycleBeforeIdle),
      executionTerminalCheckpoint: null,
      executionContinuationId: null,
    };
    void child.exited.then(async (exit) => {
      // As in completeTurn, drain final stdout before deciding what was lost.
      await new Promise<void>((resolveDrain) => setImmediate(resolveDrain));
      if (!turn.lifecycleSettlementDeferred) adapter.observeNativeExit(handle, turn, exit);
    });
    handle.liveTurn = turn;
    handle.state = "working";
    let turnCheckpointed = false;
    try {
      // The wrapper already exists and has installed its disconnect/SIGTERM
      // not-started journal, but native Cursor is still paused. Production
      // daemon delivery persists the exact supervisor turn and wrapper birth
      // in one transaction before release. The split callbacks remain only as
      // a compatibility path for direct adapter consumers during upgrade.
      if (roomTurnId) {
        if (checkpointPreparedTurn) {
          await checkpointPreparedTurn({
            providerTurnId: roomTurnId,
            providerContinuationId: handle.providerContinuationId!,
            providerConnection: handle.providerConnection,
          });
        } else {
          await checkpointTurnStarted?.(roomTurnId);
          await checkpointProviderState?.({
            providerContinuationId: handle.providerContinuationId!,
            providerConnection: handle.providerConnection,
          });
        }
        turnCheckpointed = true;
      } else {
        await checkpointProviderState?.({
          providerContinuationId: handle.providerContinuationId!,
          providerConnection: handle.providerConnection,
        });
      }
      throwIfCursorTurnLaunchAborted(launchSignal, roomTurnId);
      if (handle.liveTurn !== turn || turn.interruptRequested || handle.stopRequested) {
        throw new CursorRoomTurnNotDispatchedError(
          "Cursor turn preparation was interrupted at the durable checkpoint boundary.",
          roomTurnId,
        );
      }
      if (workspaceGeneration) {
        if (!handle.supervisedProfile) throw new Error("Cursor conversation profile is unavailable.");
        conversationLoanAttempted = true;
        adapter.deps.relocateConversationNamespace(handle.supervisedProfile,
          workspaceGeneration.realWorkspace, workspaceGeneration.liveWorkspace, nativeResumeSession);
      }
      // The exact turn id and wrapper birth are both committed. Flip the
      // daemon's drain boundary and unlink handoff cancellation in one
      // synchronous callback immediately before native release.
      markDurableTurnStarted?.();
      if (handle.liveTurn !== turn || turn.interruptRequested || handle.stopRequested) {
        throw new CursorRoomTurnNotDispatchedError(
          "Cursor turn preparation was interrupted before native release.",
          roomTurnId,
        );
      }
    } catch (error) {
      await adapter.terminateTurnChild(turn.pid, child.exited, turn.processIdentity, child.ownsDescendantReaping, nativeLaunchIsDeferred);
      const exit = turnCheckpointed && turn.lifecycleSettlementDeferred
        ? await adapter.readTerminatedTurnExit(turn)
        : null;
      await abandonPreparedGeneration();
      turn.workspaceGeneration = null;
      if (turnCheckpointed) {
        // The atomic prepared checkpoint may already have committed the exact
        // wrapper birth even though native work was never released. Retire
        // that dead birth while the exact inbox turn still fences this
        // callback. The daemon permits this narrow live->idle edge during
        // handoff because the old owner still holds the singleton and drain.
        if (turn.lifecycleSettlementDeferred) {
          try {
            await adapter.settlePreparedTurnIdle(
              handle,
              turn,
              exit!,
              settleLifecycleBeforeIdle,
              checkpointProviderState,
            );
          } catch (retirementError) {
            // The exact turn+wrapper checkpoint is already durable. Route
            // through exact-turn recovery so the dead birth is retired before
            // delivery can classify this inbox item as safe to rerun.
            throw new CursorPostDispatchCheckpointError(
              `Cursor prepared wrapper was reaped, but its durable idle-state retirement failed: ${retirementError instanceof Error ? retirementError.message : String(retirementError)}`,
            );
          }
        } else {
          handle.liveTurn = null;
          handle.state = "idle";
          await checkpointProviderState?.({
            providerContinuationId: handle.providerContinuationId!,
            providerConnection: handle.providerConnection,
          });
        }
        throw new CursorRoomTurnNotDispatchedError(
          `Cursor wrapper state could not be checkpointed before native dispatch: ${error instanceof Error ? error.message : String(error)}`,
          roomTurnId,
        );
      }
      if (handle.liveTurn === turn) handle.liveTurn = null;
      handle.state = "idle";
      if (launchSignal?.aborted) {
        throw new CursorRoomTurnNotDispatchedError(
          "Cursor turn preparation was interrupted and reaped before native dispatch.",
          roomTurnId,
        );
      }
      throw error;
    }
    // Startup gates on a VALID system/init — not on arbitrary stdout bytes. A
    // raw diagnostic line preceding init is published as evidence but must not
    // let spawn() return an uninitialized handle with no session identity
    // (msg_1758). init is the first event in the proven ordering (msg_1685),
    // so this bound is a protocol assertion, not a latency allowance.
    let signalInit: (() => void) | null = null;
    const initSeen = new Promise<"init">((resolve) => {
      signalInit = () => resolve("init");
    });
    const unsubscribe = child.onLine((line) => {
      adapter.consumeLine(handle, turn, line);
      if (turn.sawInit) signalInit?.();
    });
    const checkpointReleasedTurnIdle = async (): Promise<void> => {
      if (!turnCheckpointed || !roomTurnId || !checkpointProviderState) return;
      const providerContinuationId = handle.providerContinuationId ?? resumeSessionId;
      if (!providerContinuationId) return;
      await checkpointProviderState({
        providerContinuationId,
        providerConnection: handle.providerConnection,
      });
    };
    const settleReleasedTurnIdle = async (
      exit: ProviderProcessExit,
      outcome: "completed" | "failed" | "interrupted" | "lost",
    ): Promise<void> => {
      if (turn.lifecycleSettlementDeferred) {
        adapter.observeValidatedTurnTerminal(handle, turn, outcome);
        adapter.observeNativeRuntimeExit(handle, turn, exit);
        await settleLifecycleBeforeIdle?.();
      }
      if (handle.liveTurn === turn) handle.liveTurn = null;
      handle.state = "idle";
      try {
        await checkpointReleasedTurnIdle();
      } catch (error) {
        if (turn.lifecycleSettlementDeferred && !handle.liveTurn) handle.liveTurn = turn;
        throw error;
      }
    };
    try {
      child.release();
    } catch (error) {
      // A failed IPC send is ambiguous: the wrapper may have received release
      // immediately before the channel reported failure. Reap first and
      // reconcile as post-dispatch work; never abandon the generation or tell
      // the daemon that this exact inbox item is automatically safe to rerun.
      unsubscribe();
      await adapter.terminateTurnChild(
        turn.pid,
        child.exited,
        turn.processIdentity,
        child.ownsDescendantReaping,
        nativeLaunchIsDeferred,
      );
      const exit = await adapter.readTerminatedTurnExit(turn);
      await adapter.retireTurnWorkspaceGeneration(handle, turn);
      await settleReleasedTurnIdle(exit, "lost");
      if (roomTurnId) {
        throw new CursorPostDispatchCheckpointError(
          `Cursor native release acknowledgement was ambiguous; exact terminal recovery is required: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      adapter.finishAttempt(handle, exit, "protocol_error");
      throw error;
    }

    // The timer is REF'D and cleared: startup must stay observable even on an
    // otherwise idle loop. A turn that has passed init may run arbitrarily long
    // (quiet models are not dead — the exit event is the only terminal evidence).
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    const startTimeout = new Promise<"timeout">((resolve) => {
      startTimer = setTimeout(() => resolve("timeout"), adapter.turnStartTimeoutMs);
    });
    const first = await Promise.race([
      initSeen,
      child.exited.then(() => "exited" as const),
      startTimeout,
    ]);
    if (startTimer) clearTimeout(startTimer);
    if (first !== "init" && turn.interruptRequested) {
      // A user Stop can land after the prepared wrapper is released but before
      // Cursor emits its first valid init. The exact child has been fenced, so
      // this is a turn interruption—not evidence that the durable Cursor lane
      // itself died. Retire the wrapper birth and preserve the continuation.
      unsubscribe();
      let exit: ProviderProcessExit;
      if (first === "timeout") {
        await adapter.terminateTurnChild(turn.pid, child.exited, turn.processIdentity, child.ownsDescendantReaping);
        exit = await adapter.readTerminatedTurnExit(turn);
      } else {
        exit = await child.exited;
      }
      await adapter.retireTurnWorkspaceGeneration(handle, turn);
      await settleReleasedTurnIdle(exit, "interrupted");
      // Release already admitted native work. Missing init cannot prove that
      // nothing ran; the exact Stop reservation must settle this invocation.
      throw new CursorRoomTurnRecoveryError(
        "Cursor turn was interrupted after native release but before stream-json init; native work may have begun. The continuation remains available.",
      );
    }
    if (first === "timeout") {
      unsubscribe();
      await adapter.terminateTurnChild(turn.pid, child.exited, turn.processIdentity, child.ownsDescendantReaping);
      const exit = turn.lifecycleSettlementDeferred
        ? await adapter.readTerminatedTurnExit(turn)
        : { type: "exit" as const, code: null, signal: null };
      await adapter.retireTurnWorkspaceGeneration(handle, turn);
      await settleReleasedTurnIdle(exit, "lost");
      adapter.finishAttempt(handle, { type: "exit", code: null, signal: null }, "protocol_error");
      throw new Error("cursor-agent reported no stream-json init within the startup bound; refusing an unobservable turn.");
    }
    if (first === "exited") {
      // The child died before a valid init: terminal evidence, and the launch
      // is REJECTED — a caller must never receive an already-terminal handle.
      // (A fenced session-contract violation lands here too, since the fence
      // terminates the child before readiness can resolve.)
      unsubscribe();
      const exit = await child.exited;
      const preInitFailure = adapter.readTrustedPreInitTurnFailure(turn);
      const liveFailureDetail = preInitFailure?.errorDetail
        ?? safeCursorTerminalErrorDetail(child.terminalError?.());
      let retirementError: unknown;
      try {
        await adapter.retireTurnWorkspaceGeneration(handle, turn, preInitFailure ? true : undefined);
      } catch (error) {
        // Never reconcile a writable generation without durable containment
        // proof. Preserve the causal live-MCP diagnosis while making the safe
        // retained-for-recovery state explicit to the caller.
        retirementError = error;
      }
      await settleReleasedTurnIdle(exit, "lost");
      adapter.finishAttempt(handle, exit);
      if (retirementError) {
        if (liveFailureDetail) {
          const recoveryContext = preInitFailure
            ? "Its private workspace generation was retained because safe reconciliation did not complete."
            : "Its private workspace generation was retained for safe recovery because durable containment proof was unavailable.";
          throw new Error(
            `Cursor supervised startup failed: ${liveFailureDetail} ${recoveryContext}`,
          );
        }
        throw retirementError;
      }
      throw new Error(liveFailureDetail
        ? `Cursor supervised startup failed: ${liveFailureDetail}`
        : handle.protocolError
          ? "cursor-agent init violated the session contract; the turn was fenced."
          : "cursor-agent exited before reporting its stream-json init; the turn never became observable.");
    }
    if (handle.protocolError) {
      // consumeLine fenced a stranger session id in the init itself.
      unsubscribe();
      const exit = await child.exited;
      await adapter.retireTurnWorkspaceGeneration(handle, turn);
      await settleReleasedTurnIdle(exit, "lost");
      adapter.finishAttempt(handle, exit);
      throw new Error("cursor-agent reported a different session than the durable continuation.");
    }
    if (!handle.providerContinuationId) {
      unsubscribe();
      await adapter.terminateTurnChild(turn.pid, child.exited, turn.processIdentity, child.ownsDescendantReaping);
      const exit = await adapter.readTerminatedTurnExit(turn);
      await adapter.retireTurnWorkspaceGeneration(handle, turn);
      await settleReleasedTurnIdle(exit, "lost");
      adapter.finishAttempt(handle, { type: "exit", code: null, signal: null }, "protocol_error");
      throw new Error("cursor-agent init carried no session id; refusing an unverifiable continuation.");
    }

    try {
      await checkpointProviderState?.({
        providerContinuationId: handle.providerContinuationId,
        providerConnection: handle.providerConnection,
      });
    } catch (error) {
      unsubscribe();
      await adapter.terminateTurnChild(turn.pid, child.exited, turn.processIdentity, child.ownsDescendantReaping);
      const exit = await adapter.readTerminatedTurnExit(turn);
      adapter.interruptLiveDisplayTools(handle, turn);
      const reportedContinuationId = handle.providerContinuationId;
      // Do not roll back a session identity proven by Cursor's exact init.
      // The daemon checkpoint may have committed its manifest update before a
      // later durability write failed; retaining the real identity lets the
      // recovery pass retry idempotently from either persisted side.
      let trustedDurableTerminal: CursorTurnTerminal | undefined;
      if (turn.child.requiresDurableTerminalEvidence) {
        try {
          // This post-init failure enters recoverRoomTurn immediately. Never
          // seed that recovery with buffered live output: the wrapper may have
          // been SIGKILLed during teardown before proving process-group and
          // authority retirement. The same trusted terminal check used by the
          // ordinary completion path is mandatory here too. It also preserves
          // a result emitted only during TERM teardown when no live result was
          // observed before the listener detached.
          trustedDurableTerminal = adapter.readTrustedDurableTurnTerminal(handle, turn);
        } catch (evidenceError) {
          handle.protocolError = true;
          adapter.publishStream(handle, "turn/terminal_invalid", {
            reason: evidenceError instanceof Error ? evidenceError.message : String(evidenceError),
          }, "error");
          if (!turn.lifecycleSettlementDeferred) {
            adapter.finishAttempt(handle, exit, "protocol_error");
          }
          throw new CursorRoomTurnRecoveryError(
            `Cursor reported a real session but its durable checkpoint failed, and trusted terminal recovery was unavailable: ${evidenceError instanceof Error ? evidenceError.message : String(evidenceError)}`,
          );
        }
      }
      await adapter.retireTurnWorkspaceGeneration(handle, turn, trustedDurableTerminal);
      const recoveredTerminal = trustedDurableTerminal
        ?? (turn.sawResult && !handle.protocolError
          ? {
              state: "result",
              exit,
              text: turn.resultText,
              isError: turn.resultWasError,
              providerRequestId: turn.providerRequestId,
              attemptTerminal: null,
              publicationContract: "structured_room_turn_v1",
              ...(reportedContinuationId ? { providerContinuationId: reportedContinuationId } : {}),
            } satisfies CursorTurnTerminal
          : {
              state: "attempt_terminal",
              exit,
              text: null,
              isError: true,
              providerRequestId: turn.providerRequestId,
              attemptTerminal: null,
              publicationContract: "structured_room_turn_v1",
              ...(reportedContinuationId ? { providerContinuationId: reportedContinuationId } : {}),
            } satisfies CursorTurnTerminal);
      adapter.rememberRoomTurnTerminal(handle, turn, recoveredTerminal, !turn.lifecycleSettlementDeferred);
      throw new CursorPostDispatchCheckpointError(
        `Cursor reported a real session but its durable checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    turn.completion = adapter.completeTurn(handle, turn, unsubscribe);
    void turn.completion;
    return turn;
  });
}

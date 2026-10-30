/** Spawning, attaching to and resuming an OpenCode runtime. */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LETAGENTS_NPX_ARGS } from "../../mcp-config.js";
import { ProviderContinuationMissingError, synthesizeTerminalPayload, type ProviderAttachTerminal, type ProviderConnectionRef, type ProviderContinuationRef, type ProviderHandle, type ProviderSpawnRequest } from "../provider-adapter.js";
import { attestProviderSpawnPolicy } from "../provider-spawn-configuration.js";
import { sameProcessBirthIdentity, terminateFreshLaunch } from "../provider-evidence.js";
import { credentialBoundaryPluginSource, minimalOpenCodeEnvironment, OPENCODE_SERVER_USERNAME, openCodeAuthContent, openCodeConfig, parseConfiguredOpenModel, parseConfiguredOpenModelExternalReads, parseConfiguredOpenModelImageInput, seedOpenCodeConfigHome, shieldOwnerInstructions, supervisedOpenCodeMcpEnvironment, workspaceOpenCodeEnvironment, supervisedOpenCodePermissionProfileId } from "../opencode-launch-contract.js";
import { managedCommitEnvironmentFor } from "../managed-agent-commit-identity.js";
import { isOpenModelReasoningEffort, resolveOpenModelEffortCatalog, type OpenModelReasoningEffort } from "../open-model-efforts.js";
import { resolveOpenModelLimits } from "../open-model-limits.js";
import { OPENCODE_RUNTIME_VERSION } from "../opencode-runtime.js";
import { OpenCodeServerClient, type OpenCodeRuntimeAuth } from "../opencode-server-client.js";
import { type OpenCodeRuntimeControl, readRuntimeControl, safeRuntimeId, withRuntimeLaunchOwnership, writeRuntimeControl } from "./runtime-launch.js";
import { OpenCodeRuntimeGoneError, OpenCodeStartTimeoutError } from "./errors.js";
import { OpenModelAdapterTurnWait } from "./adapter-turn-wait.js";
import { OpenModelHandle } from "./handle.js";
import { protectOwnerPrivate } from "../../../../../../shared/owner-private-fs.mjs";
import { ProviderInstallError } from "../../../../../../shared/provider-executable.mjs";
import { desktopRuntimeEnvironment } from "../../desktop-shell-environment.js";
import { resolveLetAgentsMcpRuntime, type LetAgentsMcpRuntime } from "../letagents-mcp-runtime.js";

/**
 * What OpenCode starts as this agent's LetAgents MCP server. Windows runs the
 * sealed bundled runtime, as Codex, Claude Code and Cursor do: npx is a .cmd
 * file there, which needs a shell, and it would run an unpinned package whose
 * daemon client nothing checked. There is no npx fallback on Windows.
 */
export function openCodeMcpLaunch(
  devEntryPath?: string,
  platform: NodeJS.Platform = process.platform,
  resolveRuntime: () => LetAgentsMcpRuntime = () => resolveLetAgentsMcpRuntime({ env: desktopRuntimeEnvironment() }),
): { command: string[]; environment: Record<string, string> } {
  if (devEntryPath) return { command: [process.execPath, devEntryPath], environment: {} };
  if (platform !== "win32") return { command: ["npx", ...LETAGENTS_NPX_ARGS], environment: {} };
  return { command: [process.execPath, resolveRuntime().entryPath], environment: { ELECTRON_RUN_AS_NODE: "1" } };
}

export abstract class OpenModelAdapterLaunch extends OpenModelAdapterTurnWait {
  protected async assertPriorStartupProcessGone(authPath: string): Promise<void> {
    let control: OpenCodeRuntimeControl;
    try {
      control = await readRuntimeControl(authPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (control.startupIntent) {
      throw new Error(
        "The previous OpenCode startup intent has no durable process identity; refusing to start a competing runtime. An operator must verify the prior runtime is gone before clearing the sidecar.",
      );
    }
    for (const process of [control.startupProcess, control.connection]) {
      if (!process) continue;
      const currentIdentity = this.deps.getProcessIdentity(process.pid);
      if (currentIdentity === null) continue;
      if (!process.processIdentity || currentIdentity === undefined) {
        throw new Error(
          "The previous OpenCode startup process identity could not be verified; refusing to start a competing runtime.",
        );
      }
      if (!sameProcessBirthIdentity(currentIdentity, process.processIdentity)) continue;
      throw new Error(
        "The previous OpenCode startup process is still running; refusing to start a competing runtime.",
      );
    }
  }

  async spawn(req: ProviderSpawnRequest): Promise<ProviderHandle> {
    const lifecycleAuthorityMode = req.lifecycleAuthorityMode ?? "typed_shadow";
    if (lifecycleAuthorityMode === "typed" && req.deliveryMode !== "daemon_inbox") {
      throw new Error("Typed Open Model lifecycle authority requires daemon-inbox delivery.");
    }
    if (req.deliveryMode !== "daemon_inbox") {
      throw new Error("Open Model supports daemon-owned bounded room delivery only.");
    }
    if (!req.providerCredential?.baseUrl.trim() || !req.providerCredential.model.trim()) {
      throw new Error("Open Model is waiting for its desktop-held endpoint credential.");
    }
    const credential = req.providerCredential;
    const runtimeRoot = join(this.runtimeRoot, safeRuntimeId(req.workAttemptId));
    // The daemon singleton owns one provider router per live process. This
    // target-local queue therefore serializes every live admission for one
    // runtime path, while startupIntent remains the cross-process crash fence.
    return withRuntimeLaunchOwnership(runtimeRoot, () =>
      this.spawnWithRuntimeOwnership(req, lifecycleAuthorityMode, credential, runtimeRoot));
  }

  /**
   * A scratch workspace's repository keeps OpenCode from importing plugins
   * above it only if Git, run as OpenCode will run it, reads the repository.
   * This never fails the launch. A problem comes back as an owner-visible
   * launch notice, which the daemon records in the agent's activity.
   */
  protected async checkScratchWorkspaceBoundary(
    workspace: string,
    runtimeRoot: string,
    env: NodeJS.ProcessEnv,
  ): Promise<string | null> {
    const problem = await this.deps.probeGit(workspace, env)
      .catch((error: unknown) => `git check failed: ${String(error)}`);
    if (!problem) return null;
    console.warn("[open_model_workspace_boundary]", JSON.stringify({ runtimeRoot, detail: problem }));
    return `Plugin boundary not in effect: ${problem}. OpenCode cannot see this room's workspace repository, so plugins in folders above the workspace can load into it.`;
  }

  protected async spawnWithRuntimeOwnership(
    req: ProviderSpawnRequest,
    lifecycleAuthorityMode: NonNullable<ProviderSpawnRequest["lifecycleAuthorityMode"]>,
    credential: NonNullable<ProviderSpawnRequest["providerCredential"]>,
    runtimeRoot: string,
  ): Promise<ProviderHandle> {
    const appliedConfigurationRevision = attestProviderSpawnPolicy("open-model", req);
    void appliedConfigurationRevision;
    // Refused before anything is written or launched.
    const workspaceEnvironment = workspaceOpenCodeEnvironment(req.workspaceKind);
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    await protectOwnerPrivate(runtimeRoot, "directory");
    const authPath = join(runtimeRoot, "server-auth.json");
    await this.assertPriorStartupProcessGone(authPath);
    const auth: OpenCodeRuntimeAuth = {
      username: OPENCODE_SERVER_USERNAME,
      password: randomBytes(32).toString("base64url"),
    };
    const initialControl: OpenCodeRuntimeControl = { ...auth, lifecycleAuthorityMode };
    await writeRuntimeControl(authPath, initialControl);
    const pluginPath = join(runtimeRoot, "credential-boundary.mjs");
    await writeFile(pluginPath, credentialBoundaryPluginSource(), {
      encoding: "utf8",
      mode: 0o600,
    });
    const mcpLaunch = openCodeMcpLaunch(req.devMcpServerEntryPath, process.platform, this.deps.resolveMcpRuntime);
    const mcpCommand = mcpLaunch.command;
    const mcpEnvironment = {
      ...supervisedOpenCodeMcpEnvironment(
        req,
        process.env.LETAGENTS_API_URL?.trim() || "https://letagents.chat",
      ),
      ...mcpLaunch.environment,
    };
    const limits = await resolveOpenModelLimits(credential, this.deps.fetch);
    // The effort was chosen from this model's list, but the saved model can
    // change after that. An effort the endpoint does not list now is left
    // out, and the owner is told, rather than sent to be refused or ignored.
    // An endpoint that cannot be read now says nothing new, so the effort
    // checked when it was chosen is kept and every start runs the same way.
    let reasoningEffort: OpenModelReasoningEffort | null = null;
    let effortNotice: string | null = null;
    if (req.reasoningEffort) {
      const catalog = await resolveOpenModelEffortCatalog(credential, this.deps.fetch);
      const listed = catalog === null ? null : catalog.get(credential.model) ?? [];
      if (isOpenModelReasoningEffort(req.reasoningEffort) && (listed === null || listed.includes(req.reasoningEffort))) {
        reasoningEffort = req.reasoningEffort;
      } else {
        effortNotice = `Reasoning effort ${req.reasoningEffort} not used: the endpoint does not list it for this model, so the model's default applies.`;
      }
    }
    const config = openCodeConfig({
      model: credential.model,
      limits,
      baseUrl: credential.baseUrl,
      pluginUrl: pathToFileURL(pluginPath).href,
      cwd: req.cwd,
      mcpCommand,
      mcpEnvironment,
      permissionProfileId: supervisedOpenCodePermissionProfileId(req.permissionProfileId),
      imageInput: req.imageInput === true,
      reasoningEffort,
    });
    const port = await this.deps.allocatePort();
    const url = `http://127.0.0.1:${port}`;
    // Sessions, config, and auth stay isolated per runtime; the cache does
    // not. OpenCode installs the provider npm package (~61MB of node_modules)
    // on first start, and a cold per-agent cache re-downloads it on every
    // launch — minutes on a slow network, spent inside the startup window
    // where health connections can be accepted but never answered.
    const sharedCacheRoot = join(this.runtimeRoot, "shared-cache");
    await mkdir(sharedCacheRoot, { recursive: true, mode: 0o700 });
    // The shared cache cannot cover OpenCode's plugin SDK, which installs
    // into the isolated config directory rather than the cache.
    const configHome = join(runtimeRoot, "config");
    // The seed only saves time. A directory it cannot write leaves OpenCode
    // on its own install path, which must not block the launch.
    await seedOpenCodeConfigHome(configHome, OPENCODE_RUNTIME_VERSION).catch(() => undefined);
    // This one is not best-effort: without it the owner's personal
    // instructions reach the agent, so a launch that cannot write it fails.
    await shieldOwnerInstructions(configHome);
    const env = minimalOpenCodeEnvironment(process.env, {
      // Resolve gh's config before isolating OpenCode's XDG directories. Keep
      // the existing credential store location, never copy its credentials.
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || (process.env.XDG_CONFIG_HOME
        ? join(process.env.XDG_CONFIG_HOME, "gh")
        : process.platform === "win32" && process.env.APPDATA
          ? join(process.env.APPDATA, "GitHub CLI")
          : join(process.env.HOME || homedir(), ".config", "gh")),
      OPENCODE_SERVER_USERNAME: auth.username,
      OPENCODE_SERVER_PASSWORD: auth.password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_AUTH_CONTENT: openCodeAuthContent(credential.apiKey),
      XDG_DATA_HOME: join(runtimeRoot, "data"),
      XDG_CACHE_HOME: sharedCacheRoot,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: join(runtimeRoot, "state"),
      BUN_INSTALL_CACHE_DIR: join(sharedCacheRoot, "bun-install"),
      ...workspaceEnvironment,
    }, await managedCommitEnvironmentFor(req));
    const launchNotice = req.workspaceKind === "room_scratch"
      ? await this.checkScratchWorkspaceBoundary(req.cwd, runtimeRoot, env)
      : null;
    const intentControl: OpenCodeRuntimeControl = {
      ...initialControl,
      startupIntent: { url },
    };
    await writeRuntimeControl(authPath, intentControl);
    const clearStartupIntent = async (): Promise<void> => {
      try {
        const currentControl = await readRuntimeControl(authPath);
        if (currentControl.username !== intentControl.username
          || currentControl.password !== intentControl.password
          || currentControl.lifecycleAuthorityMode !== intentControl.lifecycleAuthorityMode
          || currentControl.startupIntent?.url !== intentControl.startupIntent?.url
          || currentControl.startupProcess
          || currentControl.connection) {
          throw new Error("The durable startup intent no longer matches this launch.");
        }
        await writeRuntimeControl(authPath, initialControl);
      } catch (error) {
        throw new Error(
          "OpenCode launch failed without a process id, but its startup intent could not be safely cleared; automatic recovery remains blocked.",
          { cause: error },
        );
      }
    };
    let launch: ReturnType<typeof this.deps.launch>;
    try {
      launch = this.deps.launch({
        binary: this.binary,
        args: ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
        cwd: req.cwd,
        env,
      });
    } catch (error) {
      // Refused before anything started: no process exists, and the next attempt must see this
      // reason, not a stale intent. Any other throw may come after the start, so its intent stays.
      if (error instanceof ProviderInstallError) await clearStartupIntent();
      throw error;
    }
    if (launch.child.pid === undefined || launch.child.pid === null) {
      await launch.exited;
      await clearStartupIntent();
      throw new Error("OpenCode launch did not expose a process id.");
    }
    const pid = launch.child.pid;
    await writeRuntimeControl(authPath, {
      ...auth,
      lifecycleAuthorityMode,
      startupProcess: { url, pid, processIdentity: null },
    });
    const identity = this.deps.getProcessIdentity(pid);
    if (!identity) {
      throw new Error("OpenCode process identity could not be verified.");
    }
    const client = new OpenCodeServerClient(url, auth, this.deps.fetch);
    let sessionId: string;
    let connection: Extract<ProviderConnectionRef, { kind: "opencode_server" }>;
    // One budget covers the whole launch. The first session bootstraps the
    // OpenCode instance, so it gets whatever the health wait left over rather
    // than the shorter steady-state control deadline.
    const launchDeadline = Date.now() + this.startTimeoutMs;
    let phase: "health" | "session" = "health";
    try {
      await writeRuntimeControl(authPath, {
        ...auth,
        lifecycleAuthorityMode,
        startupProcess: { url, pid, processIdentity: identity },
      });
      const ready = await this.waitForHealth(client, launch.exited, launchDeadline);
      if (!ready) throw new OpenCodeStartTimeoutError("health");
      phase = "session";
      const session = await client.createSession(
        req.agentDisplayName?.trim() || "LetAgents Open Model",
        AbortSignal.timeout(Math.max(1, launchDeadline - Date.now())),
      );
      sessionId = typeof session.id === "string" ? session.id : "";
      if (!sessionId) {
        throw new Error("OpenCode did not return a session id.");
      }
      connection = {
        kind: "opencode_server",
        url,
        pid,
        processIdentity: identity,
        serverAuthPath: authPath,
      };
      await writeRuntimeControl(authPath, {
        ...auth,
        lifecycleAuthorityMode,
        connection: { url, pid, processIdentity: identity },
      });
    } catch (error) {
      await terminateFreshLaunch({ pid, exited: launch.exited, processIdentity: identity }, this.deps, this.stopGraceMs);
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new OpenCodeStartTimeoutError(phase);
      }
      throw error;
    }
    const handle = new OpenModelHandle(
      req.workAttemptId,
      pid,
      sessionId,
      lifecycleAuthorityMode,
      connection,
      client,
      credential.model,
      "idle",
      this.deps.now,
    );
    handle.nativeOrderingVerified = true;
    handle.imageInput = req.imageInput === true;
    handle.externalReads = parseConfiguredOpenModelExternalReads(config);
    const launchNotices = [launchNotice, effortNotice].filter((notice): notice is string => notice !== null);
    if (launchNotices.length) handle.launchNotices = launchNotices;
    this.handles.set(req.workAttemptId, handle);
    this.observeTerminal(handle, launch.exited);
    this.emitRuntimeReady(handle);
    return handle;
  }

  async attach(ref: ProviderContinuationRef): Promise<ProviderHandle | ProviderAttachTerminal | null> {
    const lifecycleAuthorityMode = ref.lifecycleAuthorityMode ?? "typed_shadow";
    const resolved = await this.resolveAttachConnection(ref);
    if (!resolved) return null;
    const { connection, control, recoveredLegacyConnection } = resolved;
    // Death evidence does not depend on who holds lifecycle authority. Checking
    // it first lets the daemon settle a dead generation whose authority mode no
    // longer matches; otherwise it stays live with no handle and never recovers.
    const identity = this.deps.getProcessIdentity(connection.pid);
    if (identity === null || (typeof identity === "string" && !sameProcessBirthIdentity(identity, connection.processIdentity))) {
      const terminal = synthesizeTerminalPayload({
        exitCode: null, signal: null, providerContinuationId: ref.providerContinuationId,
        endedAt: this.deps.now(),
      });
      // A cached handle may not have observed its own exit yet; finishing it
      // emits the lost turn/control events its observers are waiting for.
      const stale = this.handles.get(ref.workAttemptId);
      if (stale) this.finish(stale, terminal, true);
      return { state: "terminal", terminal } satisfies ProviderAttachTerminal;
    }
    if ((control.lifecycleAuthorityMode ?? "typed_shadow") !== lifecycleAuthorityMode) return null;
    const cached = this.handles.get(ref.workAttemptId);
    if (cached) {
      return cached.providerContinuationId === ref.providerContinuationId
        && cached.lifecycleAuthorityMode === lifecycleAuthorityMode
        && cached.providerConnection.url === connection.url
        && cached.providerConnection.processIdentity === connection.processIdentity
        ? cached
        : null;
    }
    if (identity === undefined) return null;
    const auth: OpenCodeRuntimeAuth = {
      username: control.username,
      password: control.password,
    };
    const client = new OpenCodeServerClient(connection.url, auth, this.deps.fetch);
    if (!await client.health()) return null;
    const sessions = await client.listSessions();
    if (!sessions.some((session) => session.id === ref.providerContinuationId)) {
      throw new ProviderContinuationMissingError(ref.providerContinuationId);
    }
    const runtimeConfig = await client.config();
    const configuredModel = parseConfiguredOpenModel(runtimeConfig);
    if (!configuredModel) throw new Error("The attached OpenCode runtime has no configured Open Model.");
    // OpenCode looks for its instruction files again on every turn, so a
    // runtime launched before the shield existed gains it here. Unlike a
    // launch, this is best-effort: the runtime is already running, and
    // refusing to attach would only take a working agent away. The sidecar
    // path comes from a persisted reference, so nothing is written unless it
    // is this adapter's own directory for the work attempt.
    const ownRuntimeRoot = join(this.runtimeRoot, safeRuntimeId(ref.workAttemptId));
    if (connection.serverAuthPath === join(ownRuntimeRoot, "server-auth.json")) {
      await shieldOwnerInstructions(join(ownRuntimeRoot, "config")).catch(() => undefined);
    }
    const handle = new OpenModelHandle(
      ref.workAttemptId,
      connection.pid,
      ref.providerContinuationId,
      lifecycleAuthorityMode,
      connection,
      client,
      configuredModel,
      "idle",
      this.deps.now,
    );
    // The runtime keeps the configuration it started with, whatever was saved since.
    handle.imageInput = parseConfiguredOpenModelImageInput(runtimeConfig);
    handle.externalReads = parseConfiguredOpenModelExternalReads(runtimeConfig);
    this.handles.set(ref.workAttemptId, handle);
    this.observeTerminal(handle, this.deps.observeProcessExit(connection.pid, connection.processIdentity));
    if (recoveredLegacyConnection) {
      await writeRuntimeControl(connection.serverAuthPath, {
        ...auth,
        lifecycleAuthorityMode,
        connection: {
          url: connection.url,
          pid: connection.pid,
          processIdentity: connection.processIdentity,
        },
      });
    }
    this.emitRuntimeReady(handle);
    return handle;
  }

  protected async resolveAttachConnection(ref: ProviderContinuationRef): Promise<{
    connection: Extract<ProviderConnectionRef, { kind: "opencode_server" }> & {
      pid: number;
      processIdentity: string;
    };
    control: OpenCodeRuntimeControl;
    recoveredLegacyConnection: boolean;
  } | null> {
    const persisted = ref.providerConnection;
    const defaultAuthPath = join(
      this.runtimeRoot,
      safeRuntimeId(ref.workAttemptId),
      "server-auth.json",
    );
    const authPath = persisted?.kind === "opencode_server"
      ? persisted.serverAuthPath
      : defaultAuthPath;
    let control: OpenCodeRuntimeControl;
    try {
      control = await readRuntimeControl(authPath);
    } catch {
      return null;
    }
    if (persisted?.kind === "opencode_server") {
      if (persisted.pid === null || !persisted.processIdentity) return null;
      return {
        connection: {
          ...persisted,
          pid: persisted.pid,
          processIdentity: persisted.processIdentity,
        },
        control,
        recoveredLegacyConnection: false,
      };
    }
    const recorded = control.connection;
    const discovered = recorded ?? await this.deps.discoverRuntimeConnection(
      join(this.runtimeRoot, safeRuntimeId(ref.workAttemptId)),
    );
    if (!discovered) return null;
    const processIdentity = recorded
      ? recorded.processIdentity
      : this.deps.getProcessIdentity(discovered.pid);
    if (!processIdentity) return null;
    return {
      connection: {
        kind: "opencode_server",
        url: discovered.url,
        pid: discovered.pid,
        processIdentity,
        serverAuthPath: authPath,
      },
      control,
      recoveredLegacyConnection: !recorded,
    };
  }

  async resume(ref: ProviderContinuationRef, req: ProviderSpawnRequest): Promise<ProviderHandle> {
    // Load-bearing two-writer invariant: attach() may return null when process
    // identity or local control authentication is unreadable. resume() must
    // never interpret that uncertainty as permission to spawn a replacement.
    // Only a terminal identity proves that the saved writer is gone.
    const attached = await this.attach(ref);
    // Terminal identity is proof the process is gone: the daemon must recover
    // by starting a fresh runtime, not retry resume against a corpse. This is
    // checked before the authority comparison so a dead runtime born under an
    // older mode is replaced instead of refused on every attempt.
    if (attached && "state" in attached) throw new OpenCodeRuntimeGoneError();
    if ((ref.lifecycleAuthorityMode ?? "typed_shadow") !== (req.lifecycleAuthorityMode ?? "typed_shadow")) {
      throw new Error("Open Model resume lifecycle authority does not match the frozen provider birth.");
    }
    if (attached) return attached;
    throw new Error("The saved OpenCode process could not be authenticated; refusing to start a competing runtime.");
  }

  async poke(): Promise<void> {
    throw new Error("Open Model does not support mid-turn message injection.");
  }
}

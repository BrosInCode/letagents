/** Adapter state, construction, publishing helpers, exit observation and the Read-only and isolation guards. */
import type { CodexAppServerExit } from "../codex-app-server.js";
import { sandboxedCodexProjectRefusal } from "../codex-agent-home.js";
import { STARTS_AGAIN_BY_ITSELF, codexProcessKeepsOwnerSetup } from "../codex-home-harness.js";
import { resolveCodexExecutable } from "../codex-executable.js";
import { desktopRuntimeEnvironment } from "../../desktop-shell-environment.js";
import type { NativeExecutionFact } from "../../../../shared/execution-protocol.js";
import { synthesizeTerminalPayload, type ProviderActivityEvent, type ProviderAdapterCapabilities, type ProviderAttachTerminal, type ProviderContinuationRef, type ProviderHandle, type ProviderStopOptions, type ProviderStreamEvent, type ProviderStreamEventKind, type ProviderTerminalPayload } from "../provider-adapter.js";
import { errorMessage, safeStreamPayload } from "../provider-evidence.js";
import { BASE_CODEX_CAPABILITIES, DEFAULT_DEPENDENCIES } from "./launch-contract.js";
import { COMMAND_OUTPUT_WINDOW_MS, type CodexProviderAdapterDependencies, type CodexProviderAdapterOptions } from "./types.js";
import { CodexProviderHandle } from "./handle.js";
import { codexFoundNotReadOnly, codexPolicyIsSandboxed } from "./thread-access.js";
import { recordValue } from "./notifications.js";

export abstract class CodexAdapterBase {
  /** Implemented by CodexAdapterLifecycle. */
  abstract stop(
    providerHandle: ProviderHandle,
    options?: ProviderStopOptions,
  ): Promise<ProviderTerminalPayload>;
  /** Implemented by CodexAdapterEvents. */
  protected abstract emitNativeRuntimeUnavailable(
    handle: CodexProviderHandle,
    controlEvidence: "process_exit" | "native_session_terminated",
  ): void;
  readonly id = "codex" as const;
  protected readonly codexBin: string;
  protected readonly deps: CodexProviderAdapterDependencies;
  protected readonly activitySink?: (event: ProviderActivityEvent) => void;
  protected readonly streamSink?: (event: ProviderStreamEvent) => void;

  protected readonly handles = new Map<string, CodexProviderHandle>();
  protected readonly pollingLaunches = new WeakMap<CodexProviderHandle, { roomId: string; cwd: string; configurationRevision: number | undefined; agentSessionId: string }>();
  protected readonly pollingDispatches = new WeakSet<CodexProviderHandle>();
  protected readonly nonPollingLaunches = new WeakSet<CodexProviderHandle>();
  protected readonly pendingAttaches = new Map<string, {
    ref: ProviderContinuationRef;
    promise: Promise<CodexProviderHandle | ProviderAttachTerminal | null>;
  }>();
  protected readonly exitPromises = new WeakMap<CodexProviderHandle, Promise<ProviderTerminalPayload>>();
  // P0 proved app-server thread/resume on the supported Codex runtime. Start
  // optimistic so a fresh reconciler can select resume, then durably downgrade
  // if an exact continuation resume returns method-not-found. Do not probe with
  // a synthetic thread id: some app-server versions treat that as a fatal
  // protocol error, which must never prevent a genuinely fresh thread/start.
  protected resumeSupported = true;

  constructor(options: CodexProviderAdapterOptions = {}) {
    this.codexBin = options.codexBin || resolveCodexExecutable({ env: desktopRuntimeEnvironment() });
    this.deps = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
    this.activitySink = options.activitySink;
    this.streamSink = options.streamSink;
    this.commandOutputWindowMs = options.commandOutputWindowMs ?? COMMAND_OUTPUT_WINDOW_MS;
  }
  protected readonly commandOutputWindowMs: number;

  capabilities(): ProviderAdapterCapabilities {
    return {
      ...BASE_CODEX_CAPABILITIES,
      resume: this.resumeSupported,
      continuationRepair: "same_process",
    };
  }

  /**
   * A command can print thousands of chunks in one burst, and each chunk used
   * to be one fact in the execution record. A burst larger than the record's
   * intake holds overflowed it, and the agent's record had a gap from then on.
   * Adding up only what one read held was not enough: a command that streams
   * a chunk every few milliseconds, as an install or a test run does, filled
   * the record just the same. The chunks of one command are now added up for
   * up to COMMAND_OUTPUT_WINDOW_MS and recorded as one fact: before the next
   * fact of any other kind (the command's own end, a turn's end, the process
   * exiting), and at the latest when the window closes. Commands that print
   * in turn are each added up on their own, in the order they first printed
   * in the window, so a window is as many facts as commands printed in it.
   */
  protected noteCommandOutput(
    handle: CodexProviderHandle,
    identity: { providerContinuationId: string; providerTurnId: string },
    executionId: string,
    outputBytes: number,
  ): void {
    if (handle.nativeRuntimeUnavailable) return;
    const key = JSON.stringify([identity.providerContinuationId, identity.providerTurnId, executionId]);
    const pending = handle.pendingCommandOutput.get(key);
    if (pending) {
      pending.outputBytes += outputBytes;
      return;
    }
    if (!handle.pendingCommandOutput.size) {
      handle.pendingCommandOutputTimer = setTimeout(() => this.recordCommandOutput(handle), this.commandOutputWindowMs);
      handle.pendingCommandOutputTimer.unref?.();
    }
    handle.pendingCommandOutput.set(key, { ...identity, executionId, outputBytes });
  }

  protected recordCommandOutput(handle: CodexProviderHandle): void {
    if (handle.pendingCommandOutputTimer) { clearTimeout(handle.pendingCommandOutputTimer); handle.pendingCommandOutputTimer = null; }
    if (!handle.pendingCommandOutput.size) return;
    const pending = [...handle.pendingCommandOutput.values()];
    handle.pendingCommandOutput.clear();
    for (const output of pending) {
      this.emitNativeExecution(handle, { ...output, domain: "execution", operation: "command", kind: "output", sideEffects: "possible" });
    }
  }

  protected emitNativeExecution(handle: CodexProviderHandle, fact: NativeExecutionFact): void {
    this.recordCommandOutput(handle);
    if (handle.nativeRuntimeUnavailable) return;
    if (fact.domain === "execution") {
      const key = JSON.stringify([fact.providerContinuationId, fact.providerTurnId, fact.executionId]);
      if (fact.kind === "completed") handle.nativeActiveOperations.delete(key);
      else handle.nativeActiveOperations.set(key, fact);
    } else if (fact.domain === "turn") {
      const key = JSON.stringify([fact.providerContinuationId, fact.providerTurnId]);
      if (fact.state === "active") {
        handle.nativeActiveTurns.set(key, {
          providerContinuationId: fact.providerContinuationId,
          providerTurnId: fact.providerTurnId,
        });
      } else handle.nativeActiveTurns.delete(key);
    }
    handle.execution.emit(
      fact,
      handle.providerConnection.processIdentity ?? undefined,
      handle.providerConnection.pid ?? undefined,
    );
  }

  protected publishStream(
    handle: CodexProviderHandle,
    method: string,
    providerPayload: unknown,
    kind: ProviderStreamEventKind,
    summary: string | null = null,
    nativeEventId: string | null = null,
    nativeLifecyclePhase: "turn_active" | "turn_terminal" | null = null,
  ): void {
    const safe = safeStreamPayload(providerPayload);
    const event: ProviderStreamEvent = {
      workAttemptId: handle.workAttemptId,
      providerContinuationId: handle.providerContinuationId,
      observedAt: this.deps.now(),
      sequence: ++handle.streamSequence,
      provider: this.id,
      kind,
      method,
      ...(nativeEventId ? { nativeEventId } : {}),
      ...(nativeLifecyclePhase ? { nativeLifecyclePhase } : {}),
      summary,
      ...safe,
      durablePayloadRef: null,
    };
    this.streamSink?.(event);
    for (const listener of handle.streamListeners) listener(event);
  }

  /**
   * Gives a runtime that was found before the daemon supplied its policy that
   * policy. What its conversation reported then is held to the policy now, as
   * an attach with the policy holds it. Every later caller gets the same answer.
   */
  protected bindFoundPolicy(handle: CodexProviderHandle, policy: unknown): CodexProviderHandle | Promise<ProviderAttachTerminal> {
    const reported = handle.bindTurnPolicy(policy);
    const notReadOnly = reported && codexFoundNotReadOnly(handle.appliedTurnPolicy(), reported, handle.readOnlyProfile());
    if (notReadOnly) handle.foundNotReadOnly = { reported: notReadOnly, stopped: null };
    return this.stopNotReadOnly(handle) ?? handle;
  }

  /**
   * Codex says so when the settings of a conversation change. For a Read-only
   * runtime the new settings are held to the level as a reply is: a sandbox,
   * an approval policy or a permission profile other than Read-only's stops
   * the runtime, its owner is told, and the daemon starts the agent again.
   * Nothing LetAgents sends changes them, so a change is Codex's own or some
   * other client's. A notice that holds no settings says nothing either way.
   *
   * This catches a profile that Codex stops reporting. It does not show that
   * the `deny` is in force while the profile is reported: see
   * assertCodexReadOnlyApplied.
   */
  protected holdSettingsToReadOnly(handle: CodexProviderHandle, params: unknown): void {
    const settings = recordValue(recordValue(params)?.threadSettings);
    if (!settings || handle.foundNotReadOnly) return;
    const notReadOnly = codexFoundNotReadOnly(handle.appliedTurnPolicy(), {
      approvalPolicy: settings.approvalPolicy, sandbox: settings.sandboxPolicy, activePermissionProfile: settings.activePermissionProfile,
    }, handle.readOnlyProfile());
    if (!notReadOnly) return;
    handle.foundNotReadOnly = { reported: notReadOnly, stopped: null };
    // The daemon keeps an agent's activity from its stream, so this is said there before the process goes.
    this.publishStream(handle, "readOnly/stopped", {}, "provider_event", `Stopped this agent. ${notReadOnly}. ${STARTS_AGAIN_BY_ITSELF}`);
    // The stop is not waited for here; the daemon sees the process end. One that fails is tried again at the next attach.
    this.stopNotReadOnly(handle)?.catch(() => undefined);
  }

  /**
   * The stop of a runtime that was found not to be Read-only. One stop serves
   * every caller while it runs and once it has ended the process. A stop that
   * failed is not kept: the runtime takes no turn meanwhile, and the next
   * attach, or the next call here, tries again, so its process does not stay
   * until the owner restarts the agent.
   */
  protected stopNotReadOnly(handle: CodexProviderHandle): Promise<ProviderAttachTerminal> | null {
    const found = handle.foundNotReadOnly;
    if (!found) return null;
    if (!found.stopped) {
      const stopping = this.stopFoundNotReadOnly(found.reported, () => this.stop(handle));
      found.stopped = stopping;
      stopping.catch(() => { if (found.stopped === stopping) found.stopped = null; });
    }
    return found.stopped;
  }

  /**
   * A Read-only runtime found running whose conversation reports another
   * policy is not kept: a turn it is in would go on with what the level does
   * not allow. Its process is stopped, and the answer is the proof that it is
   * gone, with a line for its owner. The daemon then closes this runtime and
   * starts the agent again by its normal path. When the process cannot be
   * proved gone, the attach fails: a second writer must not start.
   */
  protected async stopFoundNotReadOnly(reported: string, stop: () => Promise<ProviderTerminalPayload>): Promise<ProviderAttachTerminal> {
    let terminal: ProviderTerminalPayload;
    try {
      terminal = await stop();
      // A stop that ends on a lost connection is not proof that the process is gone.
      if (!terminal.nativeRuntimeDeath) throw new Error("its process could not be proved gone");
    } catch (error) {
      throw new Error(`${reported}, and LetAgents could not stop the agent: ${errorMessage(error)}`);
    }
    return { state: "terminal", terminal, notices: [`${reported}, so LetAgents stopped the agent. ${STARTS_AGAIN_BY_ITSELF}`] };
  }

  /**
   * For a process that has its owner's setup: check the project still adds
   * nothing the process was not started with turned off, and stop the process
   * and refuse when it does, or when that cannot be checked. The caller then
   * never makes the call that would have loaded the project's config as the
   * owner's. The agent is idle here, and the owner is told why it stopped.
   */
  protected async stopBeforeProjectReload(handle: CodexProviderHandle, cwd: string): Promise<void> {
    const reason = await this.projectReloadRefusal(handle, cwd);
    if (!reason) return;
    // The daemon keeps an agent's activity from its stream, so this is said there before the process goes.
    this.publishStream(handle, "ownerSetup/stopped", {}, "provider_event", `Stopped this agent. ${reason}`);
    await this.stop(handle).catch(() => undefined);
    throw new Error(reason);
  }

  /**
   * For a process at a sandboxed access level: stop it and refuse when a
   * conversation it started or loaded now would read a command rule, or when
   * that cannot be checked. As above, the agent is idle and its owner is told.
   */
  protected async stopBeforeRuleLoad(handle: CodexProviderHandle, storedPolicy: unknown, cwd: string): Promise<void> {
    const policy = handle.appliedTurnPolicy() ?? recordValue(storedPolicy);
    if (!policy || !codexPolicyIsSandboxed(policy)) return;
    // The project's own rule folders are looked in by name, for every client. The rest is asked of
    // Codex with the home the process runs with, which a stand-in client cannot say.
    const reason = sandboxedCodexProjectRefusal(cwd) ?? (handle.codexHome === undefined ? null
      : await this.deps.sandboxedLoadRefusal(this.codexBin, { cwd, codexHome: handle.codexHome, writableSandbox: recordValue(policy.sandboxPolicy)?.type === "workspaceWrite" },
        (check) => { handle.writableFoldersCheck = check; })
        .catch((error: unknown) => `LetAgents could not check which command rules Codex would read (${errorMessage(error).split("\n")[0]}), `
          + `so it stopped the agent before Codex could load them. ${STARTS_AGAIN_BY_ITSELF}`))
      // A process with its owner's setup was checked against its project just before this.
      ?? (handle.codexHome === undefined || handle.ownerSetup ? null : await this.isolationChanged(handle, cwd));
    if (!reason) return;
    this.publishStream(handle, "sandboxRules/stopped", {}, "provider_event", `Stopped this agent. ${reason}`);
    await this.stop(handle).catch(() => undefined);
    throw new Error(reason);
  }

  /**
   * Why a process without its owner's setup may not start or load a
   * conversation now: an MCP server or a skill it was not started with turned
   * off, or a project that changes the room's own server. Null when it may.
   */
  protected async isolationChanged(handle: CodexProviderHandle, cwd: string): Promise<string | null> {
    const commandLine = handle.pid === null ? null : await this.deps.readCommandLine(handle.pid);
    if (!commandLine) {
      return "LetAgents could not read how this agent's Codex was started, so it stopped the agent "
        + `before Codex could load a project's MCP servers. ${STARTS_AGAIN_BY_ITSELF}`;
    }
    try {
      await this.deps.assertLiveIsolationUnchanged(this.codexBin, { commandLine, cwd, codexHome: handle.codexHome ?? null, launchOverrides: handle.launchOverrides });
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  }

  /** Why a process with its owner's setup may not load the project's config again. Null when it may. */
  protected async projectReloadRefusal(handle: CodexProviderHandle, cwd: string): Promise<string | null> {
    const commandLine = handle.pid === null ? null : await this.deps.readCommandLine(handle.pid);
    if (!commandLine) {
      return "LetAgents could not read how this agent's Codex was started, so it stopped the agent "
        + `before Codex could load the project's configuration with your own setup. ${STARTS_AGAIN_BY_ITSELF}`;
    }
    // LetAgents started this process with the owner's setup. A command line that says otherwise is not believed.
    if (!codexProcessKeepsOwnerSetup(commandLine)) {
      return "This agent's Codex is not running the way LetAgents started it, so LetAgents stopped the agent "
        + `before Codex could load the project's configuration with your own setup. ${STARTS_AGAIN_BY_ITSELF}`;
    }
    try {
      await this.deps.assertLiveProjectUnchanged(this.codexBin, { commandLine, cwd });
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  }

  protected reportDeclinedOwnerRequests(handle: CodexProviderHandle): void {
    // The daemon builds an agent's activity from its stream, so that is where it is said.
    handle.ownerRequestDeclined = (summary) => this.publishStream(handle, "mcpServer/elicitation/declined", {}, "provider_event", summary);
  }

  protected publishActivity(
    handle: CodexProviderHandle,
    input: {
      source: ProviderActivityEvent["source"];
      method: string | null;
      summary: string;
      status: ProviderActivityEvent["status"];
      checking: string;
      next_action: string;
    },
  ): void {
    const event: ProviderActivityEvent = {
      workAttemptId: handle.workAttemptId,
      providerContinuationId: handle.providerContinuationId,
      observedAt: this.deps.now(),
      source: input.source,
      method: input.method,
      summary: input.summary,
      status: input.status,
      checking: input.checking,
      nextAction: input.next_action,
    };
    this.activitySink?.(event);
    for (const listener of handle.activityListeners) listener(event);
  }

  protected observeExit(
    handle: CodexProviderHandle,
    exit: CodexAppServerExit,
  ): ProviderTerminalPayload {
    if (exit.type === "exit") {
      this.emitNativeRuntimeUnavailable(handle, "process_exit");
    } else if (!handle.nativeRuntimeUnavailable) {
      handle.execution.emit({ domain: "control", kind: "state_changed", state: "degraded", sideEffects: "none" },
        handle.providerConnection.processIdentity ?? undefined, handle.providerConnection.pid ?? undefined);
    }
    const terminal = exit.type === "error"
      ? {
        ...synthesizeTerminalPayload({
          endedAt: this.deps.now(),
          exitCode: null,
          signal: null,
          providerContinuationId: handle.providerContinuationId,
          stopRequested: handle.stopRequested,
        }),
        terminalCause: "protocol_error" as const,
      }
      : synthesizeTerminalPayload({
        endedAt: this.deps.now(),
        exitCode: exit.code,
        signal: exit.signal,
        providerContinuationId: handle.providerContinuationId,
        stopRequested: handle.stopRequested,
      });
    if (exit.type === "exit" && handle.providerConnection.pid && handle.providerConnection.processIdentity) {
      (terminal as ProviderTerminalPayload).nativeRuntimeDeath = { kind: "codex_app_server",
        pid: handle.providerConnection.pid, processIdentity: handle.providerConnection.processIdentity };
    }
    if (handle.protocolError) terminal.terminalCause = "protocol_error";
    handle.terminal = terminal;
    handle.state = terminal.terminalCause === "exited" || terminal.terminalCause === "stopped"
      ? "stopped"
      : "failed";
    handle.client.close();
    for (const waiter of handle.turnWaiters.values()) {
      waiter.reject(new Error("Codex app-server exited before the bounded room turn reached a terminal event."));
    }
    handle.turnWaiters.clear();
    handle.terminalTurns.clear();
    handle.roomTurnResults.clearAll();
    handle.permissionFileChangeProposals.clear();
    if (this.handles.get(handle.workAttemptId) === handle) {
      this.handles.delete(handle.workAttemptId);
    }
    for (const listener of handle.exitListeners) listener(terminal);
    handle.exitListeners.clear();
    return terminal;
  }

  protected requireHandle(handle: ProviderHandle): CodexProviderHandle {
    if (!(handle instanceof CodexProviderHandle)) {
      throw new Error("Provider handle does not belong to CodexProviderAdapter.");
    }
    return handle;
  }

  protected requireExitPromise(handle: CodexProviderHandle): Promise<ProviderTerminalPayload> {
    const promise = this.exitPromises.get(handle);
    if (!promise) throw new Error("Codex provider handle is missing its exit observation.");
    return promise;
  }
}

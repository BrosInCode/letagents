import { ClaudeCompaction } from "../claude-compaction.js";
import { randomUUID } from "node:crypto";
import { providerAcquisitionIdentity, retainProviderAcquisitionEvidence } from "../../../../../../shared/provider-acquisition-evidence.mjs";
import { desktopRuntimeEnvironment } from "../../desktop-shell-environment.js";
import type { ProviderAttachTerminal, ProviderConnectionRef, ProviderContinuationRef, ProviderSpawnRequest, ProviderTerminalPayload } from "../provider-adapter.js";
import { attestProviderSpawnPolicy, ownerSetupUnusedOptionsNotice, ownerSetupUnusedOptionsSaidOnce, spawnUsesHomeHarness } from "../provider-spawn-configuration.js";
import { rentalCredentialIsolationMarker } from "../rental-child-environment.js";
import { delay, observeFencedExit, sameProcessBirthIdentity, terminateFreshLaunch } from "../provider-evidence.js";
import { claudeApprovalProfileLabel, requireSupportedClaudeCodeVersion } from "../claude-code-version.js";
import { ClaudeAdapterStream } from "./adapter-stream.js";
import { ClaudeBootstrapDiagnostics, claudeStartWithoutModelText } from "./bootstrap-diagnostics.js";
import { claudeChildEnvironment, claudeTranscriptsRoot } from "./child-process.js";
import { ClaudeBootstrapError } from "./errors.js";
import { claudeCliLaunchArgs, claudeLaunchPolicyArgs, claudeOwnerSetupReadsProjectInstructionsOnly, claudeOwnerSetupStartEnvironment, ownerMcpServerNotices, ownerMcpStartupTimeoutMs } from "./launch-args.js";
import { ClaudeProviderHandle } from "./provider-handle.js";
import { CLAUDE_DAEMON_BOOTSTRAP_PROMPT, guestHasOnlyRoomTools, hasReadyRoomWorkplace, parseStreamLine, roomServerIsThisLaunchs, sessionIdOf, streamMethod, userStreamJsonLine } from "./stream-messages.js";
import type { ClaudeCliChild, ClaudeStreamMessage } from "./types.js";

/** CLI launch, the bootstrap turn, and the attach-path fence. */
export class ClaudeAdapterLaunch extends ClaudeAdapterStream {
  protected async start(
    req: ProviderSpawnRequest,
    resumeRef: ProviderContinuationRef | null,
  ): Promise<ClaudeProviderHandle> {
    return this.processCustody.acquire(req.workAttemptId, () => this.startAcquired(req, resumeRef));
  }

  protected async startAcquired(
    req: ProviderSpawnRequest,
    resumeRef: ProviderContinuationRef | null,
  ): Promise<ClaudeProviderHandle> {
    const acquisition = providerAcquisitionIdentity("claude-code", req, resumeRef?.providerContinuationId ?? null);
    const current = this.handles.get(req.workAttemptId);
    if (current && !current.terminal) {
      throw new Error(`Claude work attempt '${req.workAttemptId}' already has a live process.`);
    }
    if (!req.agentDisplayName?.trim()) {
      throw new Error("Claude spawn requires the durable agent display name from the manifest.");
    }
    if (req.deliveryMode !== "daemon_inbox") {
      throw new Error("Claude room agents require daemon_inbox delivery.");
    }
    const lifecycleAuthorityMode = req.lifecycleAuthorityMode ?? "typed_shadow";
    const versionOutput = await this.deps.readVersion(this.claudeBin);
    const approvalProfileLabel = claudeApprovalProfileLabel(req.permissionProfileId);
    requireSupportedClaudeCodeVersion(versionOutput, approvalProfileLabel);

    const homeHarness = spawnUsesHomeHarness("claude-code", req);
    // With the owner's setup this is the access level's own options and nothing else the stored policy holds.
    const attestedPolicy = attestProviderSpawnPolicy("claude-code", req);
    const policyArgs = claudeLaunchPolicyArgs(attestedPolicy);
    // A workspace that would commit as the host's global Git identity commits
    // as the owner's GitHub noreply identity instead; rentals never get one.
    const commitEnvironment = await this.deps.resolveCommitEnvironment(req);
    const supervisorEnv = req.supervisorEntryId && req.supervisorSocketPath && req.supervisorExecutionGenerationId
      ? {
        LETAGENTS_SUPERVISOR_ENTRY_ID: req.supervisorEntryId,
        LETAGENTS_SUPERVISOR_DAEMON_SOCKET: req.supervisorSocketPath,
        LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: req.workAttemptId,
        LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: req.supervisorExecutionGenerationId,
        ...(req.supervisorWorkerSession ? {
          LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: req.supervisorWorkerSession.agentSessionId,
          LETAGENTS_SUPERVISOR_ROOM_ID: req.roomId,
          LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: req.agentDisplayName.trim(),
        } : {}),
        LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
        LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
        ...(req.supervisorEntryId.startsWith("supervised_rental_") ? {
          [rentalCredentialIsolationMarker]: "1",
        } : {}),
        ...(req.permissionProfileId ? { LETAGENTS_PERMISSION_PROFILE_ID: req.permissionProfileId } : {}),
      }
      : undefined;
    // Claude hands its own environment to every MCP server and hook it
    // starts. With the owner's own setup on those include the owner's, so the
    // coordinates go to the room's server alone, in its own configuration.
    if (homeHarness && !supervisorEnv) {
      throw new Error("Claude can use its owner's own setup only as a daemon-supervised room agent.");
    }
    const managedMcpConfig = homeHarness
      ? await this.deps.createLetAgentsMcpConfig(req, supervisorEnv)
      : await this.deps.createLetAgentsMcpConfig(req);
    // Use an explicit strict config so a repo-tracked .mcp.json cannot shadow
    // the managed room workplace. The short-lived 0600 config lives outside
    // the worktree, its path (never its credential) enters argv, and it is
    // deleted as soon as Claude reports the initialized MCP workplace.
    // The spike (msg_1382) proved both identity paths: a minted --session-id is
    // honored verbatim on fresh spawns, and --resume continues the SAME session
    // id. Either way the continuation is asserted against init below.
    const expectedSessionId = resumeRef ? resumeRef.providerContinuationId : randomUUID();
    const bootstrapTurnId = randomUUID();
    const ownerMcpStartupMs = homeHarness ? ownerMcpStartupTimeoutMs(this.deps.ownerMcpTimeout?.() ?? desktopRuntimeEnvironment().MCP_TIMEOUT) : 0;
    const args = claudeCliLaunchArgs({
      approvalProfileLabel,
      homeHarness,
      ...(homeHarness ? { ownerMcpStartupMs, cwd: req.cwd } : {}),
      mcpConfigPath: managedMcpConfig.path,
      policyArgs,
      model: req.model,
      effort: req.reasoningEffort ?? null,
      session: resumeRef ? { resume: resumeRef.providerContinuationId } : { sessionId: expectedSessionId },
    });
    // With the owner's setup the CLI is told how to start their servers, and is not given the coordinates.
    const launchEnv = homeHarness
      ? { ...commitEnvironment, ...claudeOwnerSetupStartEnvironment(ownerMcpStartupMs, claudeOwnerSetupReadsProjectInstructionsOnly(policyArgs)) }
      : Object.keys(commitEnvironment).length ? { ...commitEnvironment, ...supervisorEnv } : supervisorEnv;
    let child: ClaudeCliChild;
    try {
      child = this.deps.launchChild({
        claudeBin: this.claudeBin, args, cwd: req.cwd, env: launchEnv, ...(homeHarness ? { ownerSetup: true as const } : {}),
      });
    } catch (error) {
      await managedMcpConfig.dispose();
      throw error;
    }

    const captureBirth = this.processCustody.record(req.workAttemptId, child);
    const processIdentity = captureBirth();
    if (child.pid === null) {
      // Node exposes no safe signalling target in this state. Fail closed until
      // the launch itself proves terminal instead of retrying beside an orphan.
      await child.exited;
      await managedMcpConfig.dispose();
      throw new Error(
        "Claude CLI launch did not expose a process id; refusing to start an unfenceable writer.",
      );
    }

    if (typeof processIdentity !== "string" || !processIdentity) {
      child.markIntentionalClose();
      await terminateFreshLaunch(child, this.deps, this.stopGraceMs);
      await managedMcpConfig.dispose();
      throw new Error(
        "Claude CLI process identity could not be verified; refusing to start an unfenceable writer.",
      );
    }

    let handle: ClaudeProviderHandle | null = null;
    // The owner's servers get their own time to start on top of the launch's budget.
    const startupBudgetMs = (resumeRef ? this.resumeInitTimeoutMs : this.initTimeoutMs) + ownerMcpStartupMs;
    const diagnostics = new ClaudeBootstrapDiagnostics(expectedSessionId, bootstrapTurnId, startupBudgetMs);
    const compaction = new ClaudeCompaction(expectedSessionId, startupBudgetMs,
      this.compactionTimeoutMs, this.deps.now, req.onProgress);
    this.compactions.set(req.workAttemptId, compaction);
    const closeCompaction = () => {
      compaction.close();
      if (this.compactions.get(req.workAttemptId) === compaction) this.compactions.delete(req.workAttemptId);
    };
    void child.exited.then(closeCompaction);
    const unsubscribeCompactionDisconnect = child.onDisconnect(() => compaction.clear());
    let capturingBootstrap = true;
    const pendingLines: string[] = [];
    let init: ClaudeStreamMessage | null = null;
    let resolveInit: ((message: ClaudeStreamMessage) => void) | null = null;
    const initPromise = new Promise<ClaudeStreamMessage>((resolve) => { resolveInit = resolve; });
    const unsubscribeLines = child.onLine((line) => {
      if (capturingBootstrap) diagnostics.observe(line);
      if (!init) {
        const parsed = parseStreamLine(line);
        if (parsed && parsed.type === "system" && parsed.subtype === "init") {
          init = parsed;
          resolveInit?.(parsed);
          return;
        }
        pendingLines.push(line);
        return;
      }
      if (!handle) {
        pendingLines.push(line);
        return;
      }
      this.consumeLine(handle, line);
    });

    const bootstrapFailure = Symbol("bootstrap-failure");
    const initTimeout = compaction.deadline.then(type => ({ [bootstrapFailure]: { type } }));
    try {
      // Claude does not emit init until it receives one stdin user frame. This
      // bootstrap establishes the continuation but deliberately does no room
      // work; every real message is claimed and dispatched by the daemon.
      child.writeLine(userStreamJsonLine(CLAUDE_DAEMON_BOOTSTRAP_PROMPT, bootstrapTurnId));

      // Keep the raw observation promises and map only process exit, retaining
      // the established precedence for exact results consumed in the same batch.
      const observedInit = await Promise.race([
        initPromise,
        child.exited.then(exit => ({ [bootstrapFailure]: exit })),
        initTimeout,
      ]);
      if (bootstrapFailure in observedInit) {
        const failure = observedInit[bootstrapFailure];
        // A start that ran out of time with the owner's setup on is most often waiting on something of the owner's.
        const waitedOnOwnerSetup = homeHarness && failure.type !== "exit" && failure.type !== "error";
        throw new ClaudeBootstrapError("init", failure, diagnostics.summary(child, compaction.diagnosticFields())
          + (waitedOnOwnerSetup ? " This agent starts with your own Claude Code setup, so one of your MCP servers or hooks may be holding the start up." : ""));
      }
      if (approvalProfileLabel
        && (!Array.isArray(observedInit.capabilities) || !observedInit.capabilities.includes("msg_lifecycle_v1"))) {
        throw new Error("Claude tool approvals require exact native turn lifecycle support. Update Claude Code, then try again.");
      }
      // An account without automatic review starts in another mode. Running
      // there would either prompt for everything or decide nothing.
      if (req.permissionProfileId === "auto_review" && observedInit.permissionMode !== "auto") {
        throw new Error("Claude Code did not start in Auto mode. This account or Claude Code version may not support it. Choose another access level, then try again.");
      }
      // A guest must have no tool of its own on this Mac: fail closed on anything but LetAgents' tools.
      if (req.supervisorEntryId?.startsWith("supervised_rental_") && !guestHasOnlyRoomTools(observedInit)) {
        throw new Error("Claude Code started with tools that can reach this Mac, so the given agent was not started. Update Claude Code, then try again.");
      }
      // A named but failed server is not a usable room connection.
      if (!hasReadyRoomWorkplace(observedInit)) {
        throw new Error(
          "LetAgents room tools did not connect to Claude; refusing to launch without the room workplace.",
        );
      }
      if (homeHarness && !roomServerIsThisLaunchs(observedInit)) {
        throw new Error(
          "Claude did not report the room's LetAgents server as the one this launch started, so it will not run with your own setup. Update Claude Code, then try again.",
        );
      }
      const sessionId = sessionIdOf(observedInit);
      if (!sessionId) {
        throw new Error("Claude CLI init did not include a session id.");
      }
      // Exact continuation identity, both directions (msg_1382): a fresh spawn
      // must run under the minted --session-id, and --resume must continue the
      // SAME session. Anything else is a different conversation and must not
      // silently become this work attempt's continuation.
      if (sessionId !== expectedSessionId) {
        throw new Error(
          resumeRef
            ? "Claude CLI resumed a different session than the durable continuation."
            : "Claude CLI ignored the minted session id; refusing an unverifiable continuation.",
        );
      }

      handle = new ClaudeProviderHandle(
        req.workAttemptId,
        child.pid,
        sessionId,
        lifecycleAuthorityMode,
        { kind: "claude_cli", pid: child.pid, processIdentity },
        child,
        observeFencedExit(child, child.pid, processIdentity, child.exited, this.deps),
        this.deps.now,
      );
      if (homeHarness) {
        const unused = ownerSetupUnusedOptionsSaidOnce.whenChanged(req.supervisorEntryId, ownerSetupUnusedOptionsNotice("Claude Code", req.launchPolicy, attestedPolicy));
        handle.launchNotices = [...ownerMcpServerNotices(observedInit), ...(unused ? [unused] : [])];
      }
      handle.ownerSetup = homeHarness;
      handle.transcriptsRoot = claudeTranscriptsRoot(claudeChildEnvironment({ env: launchEnv, ...(homeHarness ? { ownerSetup: true as const } : {}) }));
      this.handles.set(req.workAttemptId, handle);
      this.handleCompactions.set(handle, compaction);
      const exitPromise = handle.exitEvidence.then((exit) => this.observeExit(handle!, exit));
      this.exitPromises.set(handle, exitPromise);

      diagnostics.initialized();
      // The CLI and its MCP workplace are up. The bootstrap turn below is a
      // model round trip (up to the resume budget), not local launch work.
      try { req.onNativeStarted?.(); } catch { /* a host hint cannot fail the launch */ }
      this.publishStream(handle, streamMethod(observedInit), observedInit, "provider_event");
      const bootstrapResult = this.waitForExactRoomTurn(handle, bootstrapTurnId);
      for (const line of pendingLines.splice(0)) {
        this.consumeLine(handle, line);
      }
      const bootstrapTerminal = await Promise.race([
        bootstrapResult,
        child.exited.then(exit => ({ [bootstrapFailure]: exit })),
        initTimeout,
      ]);
      if (bootstrapFailure in bootstrapTerminal) {
        // Claude was up, so it has said which of the owner's servers did not start.
        throw new ClaudeBootstrapError("bootstrap_turn", bootstrapTerminal[bootstrapFailure], diagnostics.summary(child, compaction.diagnosticFields())
          + (handle.launchNotices.length ? ` ${handle.launchNotices.join(" ")}` : ""));
      }
      compaction.checkDeadline();
      if (compaction.failure) {
        throw new ClaudeBootstrapError("bootstrap_turn", { type: compaction.failure }, diagnostics.summary(child, compaction.diagnosticFields()));
      }
      if ("error" in bootstrapTerminal) {
        // Claude Code ended the prompt that starts the agent with no call to the model. The owner reads what
        // happened, and nothing of the CLI's text. A hook that stopped the prompt stops it at each start, so
        // the failure is given no mark of one that passes: no start is tried again by itself, and the agent
        // waits for its owner. A hook's stop needs no list of observations; a cause that is not known does.
        if (bootstrapTerminal.modelNotCalled) {
          throw new ClaudeBootstrapError("bootstrap_turn", { type: "failed_response" },
            bootstrapTerminal.modelNotCalled === "hook_stopped_prompt" ? "" : diagnostics.summary(child, compaction.diagnosticFields()), null, null,
            claudeStartWithoutModelText({ modelNotCalled: bootstrapTerminal.modelNotCalled, ownerSetup: homeHarness,
              namesSettingSources: policyArgs.includes("--setting-sources") }));
        }
        throw new ClaudeBootstrapError("bootstrap_turn", { type: "failed_response" },
          diagnostics.summary(child, compaction.diagnosticFields()), diagnostics.apiError, diagnostics.usageLimitResetsAtMs);
      }
      handle.roomTurnResults.delete(bootstrapTurnId);
      handle.roomTurnsWithoutAnswer.delete(bootstrapTurnId);
      handle.state = "idle";
      handle.execution.emit(
        { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" },
        processIdentity,
        child.pid ?? undefined,
      );
      return handle;
    } catch (error) {
      capturingBootstrap = false;
      closeCompaction();
      unsubscribeCompactionDisconnect();
      if (handle) {
        handle.protocolError = true;
        ownerSetupUnusedOptionsSaidOnce.forget(req.supervisorEntryId, handle.launchNotices);
      } else {
        unsubscribeLines();
      }
      child.markIntentionalClose();
      await terminateFreshLaunch(child, this.deps, this.stopGraceMs);
      // Cleanup returning is not death. Retain only the existing exact exit
      // observation from this rejected child, without admitting its handle.
      if (handle?.terminal?.nativeRuntimeDeath && handle.providerConnection.kind === "claude_cli") {
        retainProviderAcquisitionEvidence(error, acquisition, handle.providerConnection, handle.terminal);
      }
      throw error;
    } finally {
      capturingBootstrap = false;
      compaction.finishBootstrap();
      await managedMcpConfig.dispose();
    }
  }

  /** The attach-path fence for a recorded child this adapter cannot reattach. */
  protected async fenceRecordedChild(
    connection: Extract<ProviderConnectionRef, { kind: "claude_cli" }>,
    providerContinuationId: string,
    stop?: { force: boolean; graceMs: number; birthEvidence: (identity: string) => boolean },
  ): Promise<ProviderAttachTerminal> {
    if (connection.pid === null || !connection.processIdentity) {
      throw new Error(
        "Claude CLI attach is ambiguous; the durable endpoint has no verified process identity.",
      );
    }
    const readIdentity = () => {
      const identity = this.deps.getProcessIdentity(connection.pid!);
      if (stop && typeof identity === "string" && !stop.birthEvidence(identity)) {
        throw new Error("Claude exact-reference stop is ambiguous because process birth cannot be verified.");
      }
      return identity;
    };
    const identity = readIdentity();
    if (identity === undefined) {
      throw new Error(
        "Claude CLI attach is ambiguous; the recorded process identity cannot be verified.",
      );
    }
    if (identity === null || !sameProcessBirthIdentity(identity, connection.processIdentity)) {
      // The recorded child is verifiably gone (a recycled pid is NOT it and is
      // never signalled). Proven absent — bounded recovery may proceed.
      return this.attachTerminal(connection, providerContinuationId, null, "crashed");
    }
    // A previous daemon's stdin disappearing normally gives Claude EOF. Let
    // that exact orphan finish and flush its JSONL terminal boundary before
    // fencing it; recovery can then prove the already-started turn without a
    // duplicate dispatch.
    const exitedNaturally = !stop && await Promise.race([
      this.deps.observeProcessExit(connection.pid, connection.processIdentity).then(() => true),
      delay(this.stopGraceMs).then(() => false),
    ]);
    if (exitedNaturally) {
      return this.attachTerminal(connection, providerContinuationId, null, "crashed");
    }
    const identityBeforeTerm = readIdentity();
    if (identityBeforeTerm === undefined) {
      throw new Error(
        "Claude CLI attach is ambiguous; the orphaned child's identity cannot be verified.",
      );
    }
    if (identityBeforeTerm === null || !sameProcessBirthIdentity(identityBeforeTerm, connection.processIdentity)) {
      return this.attachTerminal(connection, providerContinuationId, null, "crashed");
    }
    // The exact recorded child is still alive but unreachable (its stdio died
    // with the previous supervisor). It may still be writing the workspace, so
    // it must be terminal before any replacement generation exists.
    const signal = stop?.force ? "SIGKILL" : "SIGTERM";
    this.deps.signalProcess(connection.pid, signal, connection.processIdentity);
    await delay(stop?.graceMs ?? this.stopGraceMs);
    const identityBeforeKill = readIdentity();
    if (identityBeforeKill === undefined) {
      throw new Error(
        "Claude CLI attach is ambiguous; the orphaned child's termination could not be verified.",
      );
    }
    if (identityBeforeKill !== null && sameProcessBirthIdentity(identityBeforeKill, connection.processIdentity)) {
      if (stop?.force) throw new Error("Claude exact-reference stop has not yet proved the recorded process birth is gone.");
      this.deps.signalProcess(connection.pid, "SIGKILL", connection.processIdentity);
      if (stop) {
        await delay(stop.graceMs);
        const finalIdentity = readIdentity();
        if (finalIdentity === undefined || (finalIdentity !== null && sameProcessBirthIdentity(finalIdentity, connection.processIdentity))) {
          throw new Error("Claude exact-reference stop has not yet proved the recorded process birth is gone.");
        }
      } else {
        await this.deps.observeProcessExit(connection.pid, connection.processIdentity);
      }
      return this.attachTerminal(connection, providerContinuationId, "SIGKILL", "killed");
    }
    return this.attachTerminal(connection, providerContinuationId, signal, signal === "SIGKILL" ? "killed" : "stopped");
  }

  protected attachTerminal(
    connection: Extract<ProviderConnectionRef, { kind: "claude_cli" }>,
    providerContinuationId: string,
    signal: string | null,
    terminalCause: ProviderTerminalPayload["terminalCause"],
  ): ProviderAttachTerminal {
    return {
      state: "terminal",
      terminal: {
        endedAt: this.deps.now(),
        exitCode: null,
        signal,
        terminalCause,
        providerContinuationId,
        nativeRuntimeDeath: { kind: "claude_cli", pid: connection.pid!, processIdentity: connection.processIdentity! },
      },
    };
  }
}

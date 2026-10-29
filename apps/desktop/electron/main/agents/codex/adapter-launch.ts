/** Starting a Codex app-server process and its first thread. */
import { CODEX_THREAD_HISTORY_MODE } from "../../../../../../shared/codex-thread-history.mjs";
import type { CodexAppServerLaunch } from "../codex-app-server.js";
import { codexReadOnlyProfileId } from "../codex-agent-home.js";
import { CODEX_GUEST_TOOL_OVERRIDES, codexGuestToolsLocked } from "../codex-guest-lock.js";
import { apiUrl as desktopApiUrl } from "../../paths.js";
import type { RpcNotification, TurnStartResult } from "../codex-rpc-client.js";
import { buildCodexDevMcpEntryOverrides } from "../codex-dev-mcp-entry.js";
import type { LetAgentsMcpRuntime } from "../letagents-mcp-runtime.js";
import { attestProviderSpawnPolicy, ownerSetupUnusedOptionsNotice, ownerSetupUnusedOptionsSaidOnce, spawnUsesHomeHarness } from "../provider-spawn-configuration.js";
import { rentalCredentialIsolationMarker } from "../rental-child-environment.js";
import { buildCodexStartPrompt, DEFAULT_CODEX_STOP_PHRASE, looksLikeInviteCode, makeCodexStopToken } from "../codex-start-prompt.js";
import type { ProviderContinuationRef, ProviderSpawnRequest } from "../provider-adapter.js";
import { errorMessage, observeFencedExit, terminateFreshLaunch } from "../provider-evidence.js";
import { CODEX_READ_ONLY_CONFIG_OVERRIDES, type CodexThreadResult, assertCodexReadOnlyApplied, assertCodexReviewerApplied, assertCodexThreadDirectory, codexAgentHomeNoticeSaidOnce, codexEffortMismatchNotice, codexEffortNoticeSaidOnce, codexPolicyIsSandboxed, codexThreadAccess, codexThreadConfig, codexThreadEffort, codexThreadIsReadOnly, sameDirectory } from "./thread-access.js";
import { CodexAdapterEvents } from "./adapter-events.js";
import { CodexProviderHandle } from "./handle.js";
import { boundedCodexTools, boundedLaunchContract, boundedMcpEnvironment, codexMcpWorkplaceConfigOverrides, codexTurnPolicy, custodialMcpOverride, custodialPollingTools, normalizeLaunchPolicy } from "./launch-contract.js";
import { isMethodNotFound, requireLetAgentsWorkplace } from "./room-tools.js";

export abstract class CodexAdapterLaunch extends CodexAdapterEvents {
  protected async resolveCustodialPollingRuntime(devEntryPath?: string): Promise<{ runtime: LetAgentsMcpRuntime; tools: string[] }> {
    const runtime = this.deps.resolveMcpRuntime(devEntryPath);
    const tools = custodialPollingTools(await this.deps.readMcpRuntimeContract(runtime.entryPath));
    return { runtime, tools };
  }

  protected async start(
    req: ProviderSpawnRequest,
    resumeRef: ProviderContinuationRef | null,
  ): Promise<CodexProviderHandle> {
    const lifecycleAuthorityMode = req.lifecycleAuthorityMode ?? "typed_shadow";
    if (lifecycleAuthorityMode === "typed" && req.deliveryMode !== "daemon_inbox") {
      throw new Error("Typed Codex lifecycle authority requires daemon-inbox delivery.");
    }
    if (req.pollingContract !== undefined && req.pollingContract !== "custodial_polling_v1") {
      throw new Error("Unsupported Codex polling contract.");
    }
    const custodialPolling = req.pollingContract === "custodial_polling_v1";
    req = { ...req, supervisorWorkerSession: req.supervisorWorkerSession && { ...req.supervisorWorkerSession } };
    resumeRef = resumeRef && { ...resumeRef };
    const current = this.handles.get(req.workAttemptId);
    if (current && !current.terminal) {
      throw new Error(`Codex work attempt '${req.workAttemptId}' already has a live process.`);
    }
    if (!req.agentDisplayName?.trim()) {
      throw new Error("Codex spawn requires the durable agent display name from the manifest.");
    }

    // With the owner's setup this is the access level's own options and nothing else the stored policy holds.
    const attestedPolicy = attestProviderSpawnPolicy("codex", req);
    const policy = normalizeLaunchPolicy(attestedPolicy);
    const turnPolicy = codexTurnPolicy(attestedPolicy);
    // Read-only limits the room tools to a named list, and the background service holds that list
    // only for an agent it delivers room messages to. An agent that collects its own messages calls
    // the room server itself, so only Codex would hold the list there. No agent ran that way before:
    // Read-only for Codex came with the list. So every launch of another kind is refused, and a
    // launch that does not say its kind is taken as one, as the rest of this start takes it.
    if (req.permissionProfileId?.trim() === "read_only" && req.deliveryMode !== "daemon_inbox") {
      throw new Error(
        "Read-only access is for a Codex agent that LetAgents delivers room messages to. This agent collects its own room messages, "
        + "so LetAgents cannot hold it to the room tools that Read-only allows, and did not start it. Choose another access level for this agent.",
      );
    }
    const supervisorCoordinates = [
      req.supervisorEntryId,
      req.supervisorSocketPath,
      req.supervisorExecutionGenerationId,
    ];
    const hasSupervisorCoordinate = supervisorCoordinates.some((value) => Boolean(value?.trim()));
    const hasCompleteSupervisorCoordinates = supervisorCoordinates.every((value) => Boolean(value?.trim()));
    if (hasSupervisorCoordinate && !hasCompleteSupervisorCoordinates) {
      throw new Error("Codex supervisor bridge coordinates are incomplete.");
    }
    const boundedMcp = req.deliveryMode === "daemon_inbox" && hasCompleteSupervisorCoordinates;
    let custodialRuntime: LetAgentsMcpRuntime | null = null;
    let custodialTools: string[] = [];
    let custodialApiUrl: string | null = null;
    if (custodialPolling) {
      if (req.deliveryMode !== "mcp_polling" || !hasCompleteSupervisorCoordinates
        || !req.roomId.trim() || !req.workAttemptId.trim() || !req.supervisorWorkerSession?.agentSessionId.trim()
        || !req.supervisorWorkerSession.apiUrl?.trim()) {
        throw new Error("Custodial polling requires exact supervisor, worker, room and API coordinates.");
      }
      try {
        const apiUrl = new URL(req.supervisorWorkerSession.apiUrl);
        if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash || apiUrl.pathname !== "/"
          || (apiUrl.protocol !== "https:" && !(apiUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(apiUrl.hostname)))) throw new Error();
        custodialApiUrl = apiUrl.origin;
      } catch { throw new Error("Custodial polling requires an exact safe worker API origin."); }
      ({ runtime: custodialRuntime, tools: custodialTools } = await this.resolveCustodialPollingRuntime(req.devMcpServerEntryPath));
    }
    if (boundedMcp) {
      custodialRuntime = this.deps.resolveMcpRuntime(req.devMcpServerEntryPath);
      custodialTools = boundedCodexTools(await this.deps.readMcpRuntimeContract(custodialRuntime.entryPath, req.supervisorWorkerSession?.apiUrl));
    }
    if (hasCompleteSupervisorCoordinates) {
      await this.deps.writeSupervisorBridgeContext(req.cwd, {
        entry_id: req.supervisorEntryId!,
        room_id: req.roomId,
        work_attempt_id: req.workAttemptId,
        execution_generation_id: req.supervisorExecutionGenerationId!,
        ...(req.supervisorWorkerSession ? {
          agent_session_id: req.supervisorWorkerSession.agentSessionId,
          ...(req.agentDisplayName?.trim() ? { agent_display_name: req.agentDisplayName.trim() } : {}),
        } : {}),
      });
    }
    const devOverrides = !custodialRuntime && req.devMcpServerEntryPath
      ? await buildCodexDevMcpEntryOverrides(req.devMcpServerEntryPath)
      : [];
    const supervisorEnvironment: Record<string, string> | undefined = req.supervisorEntryId && req.supervisorSocketPath && req.supervisorExecutionGenerationId
      ? {
          LETAGENTS_SUPERVISOR_ENTRY_ID: req.supervisorEntryId,
          LETAGENTS_SUPERVISOR_DAEMON_SOCKET: req.supervisorSocketPath,
          LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: req.workAttemptId,
          LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: req.supervisorExecutionGenerationId,
          LETAGENTS_SUPERVISOR_PROVIDER: "codex",
          ...(req.supervisorWorkerSession ? {
            LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: req.supervisorWorkerSession.agentSessionId,
            LETAGENTS_SUPERVISOR_ROOM_ID: req.roomId,
            ...(req.agentDisplayName?.trim() ? {
              LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: req.agentDisplayName.trim(),
            } : {}),
          } : {}),
          ...(req.deliveryMode === "daemon_inbox" ? {
            ...boundedMcpEnvironment,
            ...(req.supervisorEntryId.startsWith("supervised_rental_") ? {
              [rentalCredentialIsolationMarker]: "1",
            } : {}),
          } : { LETAGENTS_EXECUTION_PROFILE: custodialPolling ? "supervised_mcp_polling" : "interactive_desktop" }),
          ...(custodialPolling ? {
            LETAGENTS_API_URL: custodialApiUrl!,
            LETAGENTS_SUPERVISED_BOUNDED_TURNS: "",
            LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: "",
            LETAGENTS_TOKEN: "",
            LETAGENTS_AGENT_SESSION_BEARER: "",
          } : {}),
        } : undefined;
    const managedLaunchContract = boundedMcp && !req.devMcpServerEntryPath
      ? boundedLaunchContract(req.supervisorWorkerSession?.apiUrl || desktopApiUrl, custodialTools)
      : undefined;
    // With the owner's own setup on, the app-server's environment carries none
    // of the room agent's coordinates, so the room's server must be the sealed
    // one that is given them in its own configuration.
    const homeHarness = spawnUsesHomeHarness("codex", req);
    if (homeHarness && !custodialRuntime) {
      throw new Error("Codex can use its owner's own setup only as a daemon-supervised room agent.");
    }
    // The access level itself decides what follows, not the shape of a policy:
    // the attestation above has tied the level to its policy.
    const readOnlyLevel = req.permissionProfileId?.trim() === "read_only";
    // A Read-only agent's conversations name this permission profile in place of a sandbox. The launch defines it.
    const readOnlyProfile = readOnlyLevel ? codexReadOnlyProfileId(req.workAttemptId) : null;
    // Room tools are approved in advance only for an agent the daemon delivers
    // room messages to. Such an agent's room tools run in the daemon, on its
    // own room and workspace. An agent that collects its own messages runs them
    // in the room server with the caller's `cwd`, so none of its tools is.
    const readOnlyRoomTools = boundedMcp && readOnlyLevel;
    // A guest (an agent given to someone else's room) runs Read-only with no tool that reaches this Mac.
    // Fail closed unless this exact Codex shows, with the guest switches and this model, that it offers none.
    const guest = req.supervisorEntryId?.startsWith("supervised_rental_") === true;
    if (guest && !readOnlyLevel) throw new Error("A given Codex agent runs Read-only with no local tools.");
    if (guest && !await codexGuestToolsLocked(this.codexBin, process.env, req.model ?? null)) {
      throw new Error("Codex offered tools that can reach this Mac, so the given agent was not started. Update Codex, then try again.");
    }
    const serverUrl = await this.deps.resolveServerUrl();
    // The launch's own overrides, the room's server among them. Kept with the handle: a later check lists Codex's servers as this launch does.
    const launchOverrides = [
      ...(custodialRuntime
        ? [custodialMcpOverride(custodialRuntime.entryPath, req.cwd, {
            ...supervisorEnvironment!,
            ...(boundedMcp ? { LETAGENTS_API_URL: req.supervisorWorkerSession?.apiUrl || desktopApiUrl,
              LETAGENTS_TOKEN: "", LETAGENTS_AGENT_SESSION_BEARER: "", LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: "" } : {}),
          }, custodialTools, readOnlyRoomTools)]
        : [...codexMcpWorkplaceConfigOverrides(req.cwd), ...devOverrides]),
      // Read-only only: no other access level's launch changes.
      ...(readOnlyLevel ? CODEX_READ_ONLY_CONFIG_OVERRIDES : []),
      ...(guest ? CODEX_GUEST_TOOL_OVERRIDES : []),
    ];
    const launch = await this.deps.launchServer(serverUrl, this.codexBin, {
      trustedProjectPath: req.cwd,
      configOverrides: launchOverrides,
      ...(supervisorEnvironment ? { env: supervisorEnvironment } : {}),
      // The owner's own Codex setup stays on for this agent's app-server.
      ...(homeHarness ? { homeHarness: true } : {}),
      ...(codexPolicyIsSandboxed(turnPolicy) ? { sandboxed: true, ...(policy.sandbox === "workspace-write" ? { writableSandbox: true } : {}) } : {}),
      // A Read-only conversation names this profile, so the launch must define it: with the owner's sign-in file denied to every command.
      ...(readOnlyProfile ? { hideSignInProfile: readOnlyProfile } : {}),
      // The launch is told the policy too, whatever level was named. With this policy and no profile it starts nothing:
      // a caller that left the level's name out would otherwise get Codex's read-only sandbox alone.
      ...(codexThreadIsReadOnly(policy) ? { readOnlySandbox: true } : {}),
    });
    const ready = await this.deps.waitForServer(serverUrl, launch);
    if (!ready) {
      if (launch.pid !== null) this.deps.signalProcess(launch.pid, "SIGTERM");
      throw new Error(`Timed out waiting for Codex app-server at ${serverUrl}`);
    }
    if (launch.pid === null) {
      // Node exposes no safe signalling target in this state. Fail closed until
      // the launch itself proves terminal instead of retrying beside an orphan.
      await launch.exited;
      throw new Error(
        "Codex app-server launch did not expose a process id; refusing to start an unfenceable writer.",
      );
    }
    const processIdentity = this.deps.getProcessIdentity(launch.pid);
    if (typeof processIdentity !== "string" || !processIdentity) {
      await terminateFreshLaunch(launch, this.deps);
      throw new Error(
        "Codex app-server process identity could not be verified; refusing to start an unfenceable writer.",
      );
    }

    let handle: CodexProviderHandle | null = null;
    const pendingNotifications: RpcNotification[] = [];
    const client = this.deps.createRpcClient(serverUrl, (notification) => {
      if (!handle) {
        pendingNotifications.push(notification);
        return;
      }
      this.consumeNotification(handle, notification);
    });
    const observedLaunch: CodexAppServerLaunch = {
      pid: launch.pid,
      exited: observeFencedExit(client, launch.pid, processIdentity, launch.exited, this.deps),
    };

    try {
      await client.connect();
      const reportedHome = client.reportedCodexHome?.();
      // At a sandboxed level a Codex that does not say which home it runs with is not used. Codex
      // 0.153.4 always says. A client that cannot be asked at all is a stand-in, never the real one.
      if (codexPolicyIsSandboxed(turnPolicy) && (reportedHome === null || (launch.codexHome && reportedHome === undefined))) {
        throw new Error(
          "Codex did not say which home folder it runs with, so LetAgents cannot tell that your saved command rules stay away from this agent, and stopped it. "
          + "Update Codex, then start the agent again.",
        );
      }
      // A Codex that says it runs with another home than the one it was given has the owner's rules.
      if (launch.codexHome && !sameDirectory(reportedHome!, launch.codexHome)) {
        throw new Error(
          "Codex did not start with the home folder LetAgents gave it for this access level, so LetAgents stopped it. "
          + "Check that nothing sets CODEX_HOME for the codex command (a wrapper script or a shell alias), update Codex, then start the agent again.",
        );
      }
      await requireLetAgentsWorkplace(client);
      if (resumeRef && !this.resumeSupported) {
        throw new Error(
          "Codex app-server does not support thread/resume; bounded recovery must start a fresh generation.",
        );
      }
      const effort = await codexThreadEffort(client, policy, req.model, req.reasoningEffort);
      let threadResult: CodexThreadResult;
      if (resumeRef) {
        try {
          threadResult = await client.request<CodexThreadResult>("thread/resume", {
            threadId: resumeRef.providerContinuationId,
            cwd: req.cwd,
            ...codexThreadAccess(policy, readOnlyProfile),
            ...(req.model ? { model: req.model } : {}),
            ...codexThreadConfig(readOnlyLevel, effort),
          });
        } catch (error) {
          if (errorMessage(error) === `thread ${resumeRef.providerContinuationId} already has an active writer`) {
            throw new Error(
              "This agent's saved Codex conversation is being used by another running Codex session. "
              + "Resume this agent after that session has stopped using the conversation. LetAgents will not interrupt it.",
            );
          }
          if (!isMethodNotFound(error)) throw error;
          this.resumeSupported = false;
          throw new Error(
            "Codex app-server does not support thread/resume; bounded recovery must start a fresh generation.",
          );
        }
      } else {
        threadResult = await client.request<CodexThreadResult>("thread/start", {
          ...codexThreadAccess(policy, readOnlyProfile),
          historyMode: CODEX_THREAD_HISTORY_MODE,
          ...(req.model ? { model: req.model } : {}),
          ...codexThreadConfig(readOnlyLevel, effort),
        });
        assertCodexThreadDirectory(req.cwd, threadResult);
      }
      assertCodexReviewerApplied(policy, threadResult);
      assertCodexReadOnlyApplied(policy, threadResult, readOnlyProfile);
      const threadId = threadResult.thread?.id;
      if (!threadId) {
        throw new Error("Codex app-server did not return a thread id.");
      }
      if (resumeRef && threadId !== resumeRef.providerContinuationId) {
        throw new Error("Codex app-server resumed a different thread than requested.");
      }

      handle = new CodexProviderHandle(
        req.workAttemptId,
        launch.pid,
        threadId,
        { kind: "codex_app_server", url: serverUrl, pid: launch.pid, processIdentity },
        lifecycleAuthorityMode,
        client,
        observedLaunch,
        this.deps.now,
        turnPolicy,
      );
      handle.managedLaunchContract = managedLaunchContract;
      handle.ownerSetup = homeHarness;
      handle.readOnlyLevel = readOnlyLevel;
      handle.codexHome = reportedHome;
      handle.cwd = req.cwd;
      handle.launchOverrides = launchOverrides;
      handle.writableFoldersCheck = launch.writableFoldersCheck ?? null;
      // A start with the owner's setup asks Codex nothing more that can fail it, so a line given here reaches the owner.
      const unused = homeHarness
        ? ownerSetupUnusedOptionsSaidOnce.whenChanged(req.supervisorEntryId, ownerSetupUnusedOptionsNotice("Codex", req.launchPolicy, attestedPolicy))
        : null;
      // The effort is either not sent, or sent and reported back. A line about it is said when it changes.
      handle.effortNotice = effort.notice ?? codexEffortMismatchNotice(effort.sent, threadResult);
      handle.launchNotices = [
        unused,
        codexEffortNoticeSaidOnce.whenChanged(req.supervisorEntryId, handle.effortNotice),
        codexAgentHomeNoticeSaidOnce.whenChanged(req.supervisorEntryId, launch.notices?.join(" ") || null),
      ].filter((notice): notice is string => notice !== null);
      this.reportDeclinedOwnerRequests(handle);
      handle.setLiveState("idle");
      this.emitNativeExecution(handle, {
        domain: "runtime",
        kind: "state_changed",
        state: "ready",
        sideEffects: "none",
      });
      this.handles.set(req.workAttemptId, handle);
      if (custodialPolling) {
        handle.custodyLaunchAgentSessionId = req.supervisorWorkerSession!.agentSessionId;
        this.pollingLaunches.set(handle, { roomId: req.roomId, cwd: req.cwd, configurationRevision: req.configurationRevision,
          agentSessionId: req.supervisorWorkerSession!.agentSessionId });
      }
      else this.nonPollingLaunches.add(handle);
      const exitPromise = observedLaunch.exited.then((exit) => this.observeExit(handle!, exit));
      this.exitPromises.set(handle, exitPromise);
      for (const notification of pendingNotifications.splice(0)) {
        this.consumeNotification(handle, notification);
      }

      if (resumeRef) {
        // Read the durable continuation before starting its next turn. Besides
        // producing activity evidence, this verifies that the exact resumed
        // thread exposes its prior transcript to the new native process.
        await this.emitTranscriptTail(handle);
      }

      // Both custodial profiles return idle. Daemon-inbox starts work only
      // after its inbox claim; custodial polling activation is a later action.
      if (req.deliveryMode === "daemon_inbox" || custodialPolling) {
        handle.setLiveState("idle");
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
        ...(resumeRef && req.supervisorWorkerSession
          ? { resumeWorker: req.supervisorWorkerSession }
          : {}),
      });
      const turn = await client.request<TurnStartResult>("turn/start", {
        ...handle.requireTurnPolicy(),
        threadId,
        cwd: req.cwd,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      });
      if (!turn.turn?.id) {
        throw new Error("Codex app-server did not return a turn id.");
      }
      handle.setLiveState("working");
      void this.emitTranscriptTail(handle);
      return handle;
    } catch (error) {
      if (handle) {
        handle.protocolError = true;
        // The lines about the effort and the agents' home did not reach the owner, so the next start says them.
        codexEffortNoticeSaidOnce.forget(req.supervisorEntryId, handle.launchNotices);
        codexAgentHomeNoticeSaidOnce.forget(req.supervisorEntryId, handle.launchNotices);
      }
      client.close();
      if (launch.pid !== null) this.deps.signalProcess(launch.pid, "SIGTERM", processIdentity);
      throw error;
    }
  }
}

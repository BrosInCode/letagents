/** Attaching to a running Codex process and rebuilding its execution state. */
import type { CodexAppServerLaunch } from "../codex-app-server.js";
import type { RpcNotification, ThreadReadResult } from "../codex-rpc-client.js";
import { nativeExecutionId } from "../provider-execution-observer.js";
import { extractTurnStatus, isActiveCodexTurnStatus } from "../codex-session-status.js";
import type { ProviderAttachTerminal, ProviderConnectionRef, ProviderContinuationRef } from "../provider-adapter.js";
import { errorMessage, observeFencedExit, sameProcessBirthIdentity } from "../provider-evidence.js";
import { CodexAdapterLaunch } from "./adapter-launch.js";
import { CodexProviderHandle } from "./handle.js";
import { type CodexReportedAccess, type CodexThreadResult, codexFoundNotReadOnly, codexFoundProfile, codexTurnPolicyIsReadOnly, isMissingContinuation, isUnmaterializedEmptyThreadRead } from "./thread-access.js";
import { codexTurnPolicy } from "./launch-contract.js";
import { recordValue, transcriptLifecycleTurn } from "./notifications.js";
import { requireLetAgentsWorkplace } from "./room-tools.js";

export abstract class CodexAdapterAttach extends CodexAdapterLaunch {
  protected async attachRunning(
    ref: ProviderContinuationRef,
    connection: Extract<ProviderConnectionRef, { kind: "codex_app_server" }>,
  ): Promise<CodexProviderHandle | ProviderAttachTerminal | null> {
    const turnPolicy = ref.launchPolicy === undefined ? null : codexTurnPolicy(ref.launchPolicy);
    if (connection.pid === null || !connection.processIdentity) {
      throw new Error(
        "Codex app-server attach is ambiguous; refusing to launch a second writer: the durable endpoint has no verified process identity.",
      );
    }
    const initialIdentity = this.deps.getProcessIdentity(connection.pid);
    if (initialIdentity === undefined) {
      throw new Error(
        "Codex app-server attach is ambiguous; refusing to launch a second writer: the recorded process identity cannot be verified.",
      );
    }
    if (initialIdentity === null || !sameProcessBirthIdentity(initialIdentity, connection.processIdentity)) {
      return {
        state: "terminal",
        terminal: {
          endedAt: this.deps.now(),
          exitCode: null,
          signal: null,
          terminalCause: "crashed",
          providerContinuationId: ref.providerContinuationId,
          nativeRuntimeDeath: { kind: "codex_app_server", pid: connection.pid, processIdentity: connection.processIdentity },
        },
      };
    }
    // Whether this process has its owner's setup is what the daemon recorded
    // when it started it, never something read off the process. For every
    // other agent nothing below differs from an attach without the setup.
    const ownerSetup = ref.ownerSetup === true;
    let handle: CodexProviderHandle | null = null;
    let exactEndpointVerified = false;
    let reportedWhenFound: CodexReportedAccess | null = null;
    let notReadOnly: string | null = null;
    const pendingNotifications: RpcNotification[] = [];
    const client = this.deps.createRpcClient(connection.url, (notification) => {
      if (!handle) pendingNotifications.push(notification);
      else this.consumeNotification(handle, notification);
    });
    try {
      await client.connect();
      // Listing the app-server's MCP servers makes Codex read the project's
      // config again, and what the project gained since this process started
      // would load as the owner's. The list is only a look at a process that
      // already runs, so a process with its owner's setup is not asked for it,
      // and nor is one whose record cannot say. Nothing else here makes Codex
      // read the project again.
      if (ref.ownerSetup === undefined) await requireLetAgentsWorkplace(client);
      let read: ThreadReadResult;
      let continuationMissing = false;
      let exactEmptyFallback = false;
      try {
        read = await client.request<ThreadReadResult>("thread/read", {
          threadId: ref.providerContinuationId,
          includeTurns: true,
        });
      } catch (error) {
        if (isMissingContinuation(error, ref.providerContinuationId)) {
          // The process endpoint is still authenticated below. Preserve a live
          // handle so the daemon can journal and repair this missing
          // continuation without launching a competing app-server.
          continuationMissing = true;
          read = { thread: { id: ref.providerContinuationId, turns: [] } };
        } else {
          if (!isUnmaterializedEmptyThreadRead(error)) throw error;
          // Codex creates daemon-inbox threads before their first room turn.
          // Those threads deliberately reject includeTurns, but the metadata
          // read still proves that this exact live endpoint owns the durable
          // continuation. Never use this fallback for generic read failures.
          read = await client.request<ThreadReadResult>("thread/read", {
            threadId: ref.providerContinuationId,
            includeTurns: false,
          });
          exactEmptyFallback = true;
        }
      }
      if (read.thread?.id !== ref.providerContinuationId) {
        throw new Error("Codex app-server did not verify the exact durable continuation thread.");
      }
      exactEndpointVerified = true;
      if (connection.pid === null || !connection.processIdentity) {
        throw new Error("durable endpoint has no verified process identity");
      }
      const currentIdentity = this.deps.getProcessIdentity(connection.pid);
      if (currentIdentity === undefined) {
        throw new Error("durable endpoint process identity cannot be verified");
      }
      if (currentIdentity === null || !sameProcessBirthIdentity(currentIdentity, connection.processIdentity)) {
        throw new Error("durable endpoint process identity no longer matches its recorded birth");
      }
      const loadedThread = ["idle", "active", "systemError"].includes(String(recordValue(read.thread?.status)?.type));
      if (!continuationMissing && !exactEmptyFallback && loadedThread) {
        // thread/read verifies identity but does not subscribe this connection
        // to turn items or approval requests. Resume the exact existing thread
        // without configuration overrides or starting/replaying a turn. It names
        // no access either, a Read-only runtime's profile included: the reply is
        // then what the conversation has, not what this request asked for.
        const subscribed = await client.request<CodexThreadResult>("thread/resume", {
          threadId: ref.providerContinuationId,
        });
        if (subscribed.thread?.id !== ref.providerContinuationId) {
          throw new Error("Codex subscription resolved a different durable continuation thread.");
        }
        // The reply names the policy the loaded conversation has. For Read-only it is held to the same check as at a
        // start. Without a policy there is nothing to hold it to yet: it is kept for the call that binds one.
        notReadOnly = codexFoundNotReadOnly(turnPolicy, subscribed, codexFoundProfile(turnPolicy, ref.workAttemptId));
        if (!turnPolicy) reportedWhenFound = { approvalPolicy: subscribed.approvalPolicy, sandbox: subscribed.sandbox, activePermissionProfile: subscribed.activePermissionProfile };
        // A turn can finish between the first read and subscription without
        // sending this connection a notification. Reconstruct from a fresh
        // snapshot after subscribing so that gap cannot retain a stale turn.
        // A runtime that is about to be stopped is asked nothing more.
        if (!notReadOnly) {
          read = await client.request<ThreadReadResult>("thread/read", {
            threadId: ref.providerContinuationId, includeTurns: true,
          });
          if (read.thread?.id !== ref.providerContinuationId) {
            throw new Error("Codex subscription snapshot resolved a different durable continuation thread.");
          }
        }
      }
      const observedExit = this.deps.observeProcessExit(
        connection.pid,
        connection.processIdentity,
      );
      const exitEvidence = observeFencedExit(
        client,
        connection.pid,
        connection.processIdentity,
        observedExit,
        this.deps,
      );
      const launch: CodexAppServerLaunch = { pid: connection.pid, exited: exitEvidence };
      const found = new CodexProviderHandle(
        ref.workAttemptId,
        connection.pid,
        ref.providerContinuationId,
        connection,
        ref.lifecycleAuthorityMode ?? "typed_shadow",
        client,
        launch,
        this.deps.now,
        turnPolicy,
      );
      this.exitPromises.set(found, launch.exited.then((exit) => this.observeExit(found, exit)));
      // A runtime that failed the Read-only check is stopped, not attached. It is never kept here
      // or handed to the daemon, and what it still sends on this connection is dropped.
      if (notReadOnly) return await this.stopFoundNotReadOnly(notReadOnly, () => this.stop(found));
      handle = found;
      handle.ownerSetup = ownerSetup;
      handle.readOnlyLevel = codexTurnPolicyIsReadOnly(turnPolicy);
      handle.reportedWhenFound = reportedWhenFound;
      // A process found running is held to the same rule as a new one: see requireTurnPolicy.
      handle.codexHome = client.reportedCodexHome?.();
      const conversationFolder = recordValue(read.thread)?.cwd;
      handle.cwd = typeof conversationFolder === "string" && conversationFolder.trim() ? conversationFolder : null;
      this.reportDeclinedOwnerRequests(handle);
      handle.setLiveState(continuationMissing ? "idle" : "working");
      handle.subscriptionAfterMaterialization = exactEmptyFallback;
      this.handles.set(ref.workAttemptId, handle);
      const queuedTurnLifecycle = pendingNotifications.some(notification =>
        this.queuedTurnLifecycleIsAmbiguous(handle!, notification));
      this.reconstructAttachedExecution(
        handle,
        continuationMissing ? null : read,
        exactEmptyFallback,
        queuedTurnLifecycle,
      );
      if (!continuationMissing) {
        this.publishStream(handle, "thread/read", {
          threadId: handle.providerContinuationId,
          threadStatus: read.thread?.status,
          latestTurn: transcriptLifecycleTurn(read.thread?.turns?.at(-1)),
        }, "transcript_snapshot");
      }
      for (const notification of pendingNotifications.splice(0)) {
        this.consumeNotification(handle, notification, false);
      }
      return handle;
    } catch (error) {
      client.close();
      const currentIdentity = connection.pid !== null && connection.processIdentity
        ? this.deps.getProcessIdentity(connection.pid)
        : undefined;
      if (
        !exactEndpointVerified
        && connection.pid !== null
        && connection.processIdentity
        && currentIdentity !== undefined
        && (currentIdentity === null || !sameProcessBirthIdentity(currentIdentity, connection.processIdentity))
      ) {
        return {
          state: "terminal",
          terminal: {
            endedAt: this.deps.now(),
            exitCode: null,
            signal: null,
            terminalCause: "crashed",
            providerContinuationId: ref.providerContinuationId,
            nativeRuntimeDeath: { kind: "codex_app_server", pid: connection.pid, processIdentity: connection.processIdentity },
          },
        };
      }
      throw new Error(
        `Codex app-server attach is ambiguous; refusing to launch a second writer: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Rebuild only the bounded native boundary returned by the exact attach
   * read. The daemon still owns turn identity: it accepts this candidate only
   * when it matches an already-durable provider-turn binding.
   */
  protected reconstructAttachedExecution(
    handle: CodexProviderHandle,
    read: ThreadReadResult | null,
    exactEmptyFallback: boolean,
    queuedTurnLifecycle: boolean,
  ): void {
    this.emitNativeExecution(handle, {
      domain: "runtime",
      kind: "state_changed",
      state: "ready",
      sideEffects: "none",
    });
    if (queuedTurnLifecycle) {
      // The app-server protocol gives notifications no ordering token relative
      // to thread/read. Coexisting snapshot and lifecycle evidence is therefore
      // ambiguous even when both shapes are individually readable.
      handle.execution.markUnavailable();
      return;
    }
    if (read === null) {
      // A proven-missing continuation has no native turn to reconstruct. Keep
      // this source recoverable: same-process continuation repair replaces the
      // thread on this handle and must not inherit a permanent observation gap.
      return;
    }
    // A thread with no turn yet (daemon-inbox threads exist before their first
    // room turn) has no work to observe. Leaving the attached handle working
    // would report a turn forever and keep the agent from taking new work.
    if (exactEmptyFallback) {
      this.settleTurnlessAttach(handle, read);
      return;
    }
    const turns = read.thread?.turns;
    if (!Array.isArray(turns)) {
      handle.execution.markUnavailable();
      return;
    }
    const turn = turns.at(-1);
    if (!turn) {
      this.settleTurnlessAttach(handle, read);
      return;
    }
    const providerTurnId = turn?.id;
    const status = extractTurnStatus(turn)?.trim().toLowerCase() ?? null;
    if (!nativeExecutionId(providerTurnId) || !status) {
      handle.execution.markUnavailable();
      return;
    }
    const identity = {
      providerContinuationId: handle.providerContinuationId,
      providerTurnId,
    };
    if (isActiveCodexTurnStatus(status)) {
      this.emitNativeExecution(handle, {
        ...identity,
        domain: "turn",
        kind: "state_changed",
        state: "active",
        sideEffects: "none",
      });
      return;
    }
    const outcome = status === "completed" || status === "failed"
      ? status
      : /^(?:interrupted|cancelled|stopped)$/.test(status) ? "interrupted" : null;
    if (!outcome) {
      handle.execution.markUnavailable();
      return;
    }
    handle.setLiveState("idle");
    this.emitNativeExecution(handle, {
      ...identity,
      domain: "turn",
      kind: "state_changed",
      state: "terminal",
      turnOutcome: outcome,
      sideEffects: "none",
    });
  }

  /**
   * Idle, unless the thread itself still reports activity. A thread in a
   * system error is idle here too: daemon-inbox agents take their state from
   * typed facts, so failing only the handle would leave the agent silent and
   * unreachable instead of replaced; dispatch surfaces Codex's own error.
   */
  protected settleTurnlessAttach(handle: CodexProviderHandle, read: ThreadReadResult): void {
    if (String(recordValue(read.thread?.status)?.type) === "active") return;
    handle.setLiveState("idle");
  }

  protected queuedTurnLifecycleIsAmbiguous(
    handle: CodexProviderHandle,
    notification: RpcNotification,
  ): boolean {
    if (!(notification.method === "turn/started"
      || /^turn\/(?:completed|failed|interrupted|cancelled|stopped)$/i.test(notification.method))) return false;
    const params = recordValue(notification.params);
    if (!params || !nativeExecutionId(params.threadId)) return true;
    return params.threadId === handle.providerContinuationId;
  }
}

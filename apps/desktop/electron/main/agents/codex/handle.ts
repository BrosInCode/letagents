/** The per-process Codex provider handle and its turn-policy state. */
import { RoomTurnContextCache } from "../desktop-event-prompt-format.js";
import { ProviderUsageTracker } from "../provider-usage.js";
import type { CodexPermissionFileChange } from "../../../../shared/provider-permissions.js";
import type { CodexAppServerLaunch } from "../codex-app-server.js";
import { codexReadOnlyProfileId, sandboxedCodexHomeRefusal, sandboxedCodexProjectRefusal } from "../codex-agent-home.js";
import { ProviderExecutionObserver } from "../provider-execution-observer.js";
import type { HardControlEvidence, NativeExecutionFact } from "../../../../shared/execution-protocol.js";
import { CodexTurnResultAccumulator } from "../codex-turn-result.js";
import type { ProviderActivityEvent, ProviderAttachTerminal, ProviderConnectionRef, ProviderHandle, ProviderObservedState, ProviderStreamEvent, ProviderTerminalPayload } from "../provider-adapter.js";
import { errorMessage } from "../provider-evidence.js";
import type { CodexAdapterRpc } from "./types.js";
import { type CodexReportedAccess, codexPolicyIsSandboxed, codexTurnAccess, codexTurnPolicyIsReadOnly } from "./thread-access.js";
import { codexTurnPolicy } from "./launch-contract.js";
import { declinedOwnerRequestSummary, isUnanswerableOwnerElicitation } from "./permission-requests.js";

export function isCodexRuntimeUnavailable(state: ProviderObservedState): boolean {
  return state === "failed" || state === "stopping" || state === "stopped";
}

export class CodexProviderHandle implements ProviderHandle {
  readonly usage: ProviderUsageTracker;
  usageRead: Promise<void> | null = null;
  usageReadAt = 0;
  usageConnection = "";
  subscriptionAfterMaterialization = false;
  /** Told what was turned down for the owner, so it can be shown in the agent's activity. */
  ownerRequestDeclined: ((summary: string) => void) | null = null;
  /** The process was started with its owner's own Codex setup, so it must never reload a project's config unchecked. */
  ownerSetup = false;
  /**
   * This runtime is a Read-only agent's: every conversation it starts or loads
   * again is given the Read-only config, and names the Read-only permission
   * profile in place of a sandbox. From its launch, the level by name.
   * For a process found running, whose level is not named, its policy says it:
   * when it is found with its policy, and when the policy is bound later.
   */
  readOnlyLevel = false;
  /**
   * What the loaded conversation of a process found running reported, kept
   * only while the runtime has no policy to hold it to. The daemon can find a
   * process before it supplies the policy.
   */
  reportedWhenFound: CodexReportedAccess | null = null;
  /** Set when that report was not Read-only for a Read-only runtime: the stop that followed, and what was reported. */
  foundNotReadOnly: { reported: string; stopped: Promise<ProviderAttachTerminal> | null } | null = null;
  /**
   * The Codex home the app-server said it runs with: null when it did not
   * say. Undefined only for a client that cannot be asked, which is never the
   * real one.
   */
  codexHome: string | null | undefined = undefined;
  /** The folder this agent works in: from its launch, from a repair, or as the conversation of a process found running says. Null when none said. */
  cwd: string | null = null;
  /** The overrides this adapter's own launch gave Codex, the room's server among them. Null for a process that was found running. */
  launchOverrides: readonly string[] | null = null;
  /**
   * Why a folder the Codex config lets a sandboxed command write may not be
   * written now, as the folders were named at the launch or the last load.
   * Null for a sandbox that writes nowhere, and for a process that was found
   * running, until its next load names them.
   */
  writableFoldersCheck: (() => string | null) | null = null;
  /** Owner-visible warnings from this launch; the daemon records each in the agent's activity. */
  launchNotices: readonly string[] = [];
  /** What this runtime's launch, or its last repair that the daemon recorded, found about its reasoning effort. A repair does not say it again. */
  effortNotice: string | null = null;
  custodyLaunchAgentSessionId?: string;
  managedLaunchContract?: string;
  readonly execution: ProviderExecutionObserver;
  readonly nativeActiveTurns = new Map<string, { providerContinuationId: string; providerTurnId: string }>();
  readonly nativeActiveOperations = new Map<string, Extract<NativeExecutionFact, { domain: "execution" }>>();
  /** Output that is not in the record yet: for each command that printed, its chunks so far, added up. */
  readonly pendingCommandOutput = new Map<string, { providerContinuationId: string; providerTurnId: string; executionId: string; outputBytes: number }>();
  pendingCommandOutputTimer: ReturnType<typeof setTimeout> | null = null;
  nativeRuntimeUnavailable: HardControlEvidence | null = null;
  state: ProviderObservedState = "starting";
  stopRequested = false;
  protocolError = false;
  terminal: ProviderTerminalPayload | null = null;
  readonly exitListeners = new Set<(payload: ProviderTerminalPayload) => void>();
  readonly activityListeners = new Set<(event: ProviderActivityEvent) => void>();
  readonly streamListeners = new Set<(event: ProviderStreamEvent) => void>();
  readonly permissionInvalidationListeners = new Set<() => void>();
  /** Exact native proposals only; never persisted or projected outside this host process. */
  readonly permissionFileChangeProposals = new Map<string, {
    connectionId: string;
    threadId: string;
    turnId: string;
    changes: readonly CodexPermissionFileChange[];
  }>();
  streamSequence = 0;
  /** At most one terminal fact per recent native turn; never infer a latest turn. */
  readonly terminalTurns = new Map<string, string>();
  readonly turnWaiters = new Map<string, { owner: symbol; resolve: (status: string) => void; reject: (error: Error) => void }>();
  threadIdleEpoch = 0;
  threadIdleReconciledEpoch = 0;
  threadIdleReconciliation: Promise<void> | null = null;
  /** The one pending read after the thread reported `systemError`. */
  systemErrorReconciliation: Promise<void> | null = null;
  readonly roomTurnResults = new CodexTurnResultAccumulator();
  readonly roomContext = new RoomTurnContextCache();
  providerContinuationId: string;

  constructor(
    readonly workAttemptId: string,
    readonly pid: number | null,
    providerContinuationId: string,
    readonly providerConnection: ProviderConnectionRef,
    readonly lifecycleAuthorityMode: "legacy" | "typed_shadow" | "typed",
    readonly client: CodexAdapterRpc,
    readonly launch: CodexAppServerLaunch,
    now: () => string,
    private turnPolicy: Readonly<Record<string, unknown>> | null,
  ) {
    this.providerContinuationId = providerContinuationId;
    this.usage = new ProviderUsageTracker(providerContinuationId);
    this.execution = new ProviderExecutionObserver(now);
    client.onDisconnect(() => {
      this.roomContext.reset();
      this.permissionFileChangeProposals.clear();
      if (this.nativeRuntimeUnavailable) return;
      this.execution.emit({ domain: "control", kind: "state_changed", state: "degraded", sideEffects: "none" },
        providerConnection.processIdentity ?? undefined, providerConnection.pid ?? undefined);
    });
    client.onRequest?.((request) => {
      if (!isUnanswerableOwnerElicitation(request)) return;
      // Declining is what the server sees when a person says no.
      try { client.respond(request, { action: "decline", content: null, _meta: null }); } catch { return; /* It is no longer pending. */ }
      try { this.ownerRequestDeclined?.(declinedOwnerRequestSummary(request)); } catch { /* Reporting never controls native work. */ }
    });
  }

  /** The access every turn of this runtime is started with, once nothing stands against a turn. */
  requireTurnPolicy(): Readonly<Record<string, unknown>> {
    if (!this.turnPolicy) throw new Error("Codex cannot start a turn without its exact applied permission policy; restart the agent to apply its configuration.");
    // Its process is being stopped. Should the stop fail, it still takes no turn.
    if (this.foundNotReadOnly) throw new Error(`${this.foundNotReadOnly.reported}. Restart the agent.`);
    if (this.sandboxed()) {
      // A process that was started before agents had a home of their own, or that
      // a daemon found running, is never kept as it is: it takes no turn at a
      // sandboxed level while its home holds a saved rule, and its owner is told.
      // Nor does it take one in a project that has rule folders of its own, trusted
      // or not. Codex 0.153.4 reads rules when it starts or loads a conversation and
      // not at each turn, so a folder that appears between two turns does not reach a
      // running conversation; it is looked for here all the same, because only names
      // are read and the next load would take it.
      const refusal = (this.codexHome !== undefined ? sandboxedCodexHomeRefusal(this.codexHome) : null)
        // A stand-in client, which cannot be asked its home, is not asked for a folder it never said either.
        ?? (this.cwd !== null || this.codexHome !== undefined ? sandboxedCodexProjectRefusal(this.cwd) : null)
        // A folder the Codex config lets a command write, that has become a way into a home since it was last looked at.
        ?? this.writableFoldersRefusal();
      if (refusal) throw new Error(refusal);
    }
    // What the turn is started with: for a Read-only runtime its permission profile, never a sandbox by name.
    return codexTurnAccess(this.turnPolicy, this.readOnlyProfile());
  }

  /**
   * The permission profile this runtime names in every request and holds every reply to: the one of
   * its work attempt when it is a Read-only agent's (see `readOnlyLevel`), and none otherwise.
   */
  readOnlyProfile(): string | null {
    return this.readOnlyLevel ? codexReadOnlyProfileId(this.workAttemptId) : null;
  }

  private writableFoldersRefusal(): string | null {
    try {
      return this.writableFoldersCheck?.() ?? null;
    } catch (error) {
      // A folder that cannot be looked at is not taken as safe.
      return `LetAgents could not look at the folders your Codex config lets a sandboxed command write (${errorMessage(error).split("\n")[0]}), so it gives this agent no work. Pause the agent and resume it.`;
    }
  }

  /** Whether this runtime's access level has a sandbox. False while its policy is not known: it takes no turn then. */
  sandboxed(): boolean {
    return this.turnPolicy !== null && codexPolicyIsSandboxed(this.turnPolicy);
  }

  /** The policy this runtime was launched under, when it is known. */
  appliedTurnPolicy(): Readonly<Record<string, unknown>> | null {
    return this.turnPolicy;
  }

  /**
   * Returns what the loaded conversation reported when this runtime was found,
   * once, when this call is the one that gives the runtime its policy: nothing
   * has held that report to the policy yet.
   */
  bindTurnPolicy(policy: unknown): CodexReportedAccess | null {
    // Observation-only recovery may attach before the daemon supplies the
    // applied configuration. Bind once; later settings cannot change this birth.
    if (this.turnPolicy !== null || policy === undefined) return null;
    this.turnPolicy = codexTurnPolicy(policy);
    // As an attach with the policy does it: see `readOnlyLevel`.
    this.readOnlyLevel = codexTurnPolicyIsReadOnly(this.turnPolicy);
    const reported = this.reportedWhenFound;
    this.reportedWhenFound = null;
    return reported;
  }

  replaceContinuation(providerContinuationId: string): void {
    if (this.turnWaiters.size) {
      throw new Error("Codex continuation repair cannot replace a thread while a turn observer is active.");
    }
    if (!this.setLiveState("idle")) {
      throw new Error("Codex continuation repair cannot replace a thread on an unavailable runtime.");
    }
    this.terminalTurns.clear();
    this.roomTurnResults.clearAll();
    this.roomContext.reset();
    this.providerContinuationId = providerContinuationId;
    this.invalidatePermissions();
  }

  setLiveState(state: "idle" | "working"): boolean {
    if (isCodexRuntimeUnavailable(this.state)) return false;
    this.state = state;
    return true;
  }

  invalidatePermissions(): void {
    this.permissionFileChangeProposals.clear();
    for (const listener of this.permissionInvalidationListeners) {
      try { listener(); } catch { /* Observation never controls native work. */ }
    }
  }

  observedState(): ProviderObservedState {
    return this.state;
  }
}

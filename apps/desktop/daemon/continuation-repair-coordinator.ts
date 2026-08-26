import {
  CONTINUATION_REPAIR_EXHAUSTED_ERROR,
  continuationRepairExhaustionNeedsPersistence,
  continuationRepairMissingContinuation,
} from "./continuation-repair-policy.js";
import { redactCredentialText } from "./credential-redaction.js";
import {
  sameProviderActionConnectionIdentity,
  type ProviderActionHandle,
  type ProviderContinuationRepairRequest,
  type ProviderContinuationRepairResult,
} from "./provider-action-port.js";
import type { SupervisedIngressAgent } from "./supervised-agent-delivery.js";
import type {
  ProviderContinuationRepair,
  SupervisedInboxItem,
} from "./supervised-agent-inbox-store.js";
import type { DaemonManifestEntry, TaskWorkAttempt } from "./types.js";
import type { WorkerSessionBinding } from "./worker-binding-store.js";

export type ContinuationRepairOutcome = "restored" | "replaced" | "authority_changed" | "failed";

export type ContinuationRepairInput = {
  agent: SupervisedIngressAgent;
  item: SupervisedInboxItem;
  manual: boolean;
};

export type ContinuationRepairAuthority = {
  isHandoffScheduled(): boolean;
  currentGeneration(): number;
  assertCurrent(): Promise<void>;
};

export type ContinuationRepairInbox = {
  latest(agentId: string): Promise<ProviderContinuationRepair | null>;
  exhaust(inboxItemId: string, repairId: string, error: string): Promise<unknown>;
  begin(input: {
    agent_id: string;
    room_id: string;
    inbox_item_id: string;
    daemon_generation: number;
    execution_generation_id: string;
    work_attempt_id: string;
    expected_pid: number;
    expected_process_identity: string;
    missing_continuation: string;
  }): Promise<ProviderContinuationRepair>;
  checkpointReplacement(repairId: string, replacementContinuation: string): Promise<ProviderContinuationRepair>;
  commit(repairId: string, authoritativeContinuation: string, continuityReset: boolean): Promise<unknown>;
  fail(repairId: string, error: string): Promise<unknown>;
};

export type ContinuationRepairManifest = {
  getEntry(entryId: string): Promise<DaemonManifestEntry | null>;
  updateEntry(
    entryId: string,
    update: (entry: DaemonManifestEntry) => DaemonManifestEntry,
  ): Promise<DaemonManifestEntry>;
};

export type ContinuationRepairBindings = {
  get(entryId: string): Promise<WorkerSessionBinding | null>;
  credentialFor(binding: WorkerSessionBinding): Promise<string | null>;
};

export type ContinuationRepairDurability = {
  getAttempt(workAttemptId: string): Promise<Pick<TaskWorkAttempt, "checkpoints">>;
  checkpoint(
    workAttemptId: string,
    checkpoint: { room_cursor: string | null; provider_continuation_id: string | null },
  ): Promise<unknown>;
};

export type ContinuationRepairRuntime = {
  getHandle(entryId: string): ProviderActionHandle | undefined;
  repair?: (
    handle: ProviderActionHandle,
    request: ProviderContinuationRepairRequest,
    options: { checkpointReplacement: (providerContinuationId: string) => Promise<void> },
  ) => Promise<ProviderContinuationRepairResult>;
  promote(entryId: string, handle: ProviderActionHandle, executionGenerationId: string): Promise<void>;
};

export type ContinuationRepairCoordinatorOptions = {
  authority: ContinuationRepairAuthority;
  serializeEntry<T>(entryId: string, operation: () => Promise<T>): Promise<T>;
  inbox: ContinuationRepairInbox;
  manifest: ContinuationRepairManifest;
  bindings: ContinuationRepairBindings;
  durability: ContinuationRepairDurability;
  runtime: ContinuationRepairRuntime;
  notifyStateChanged(): void;
};

/** Repairs a missing provider continuation without changing execution authority. */
export class ContinuationRepairCoordinator {
  private readonly authority: ContinuationRepairAuthority;
  private readonly serializeEntry: ContinuationRepairCoordinatorOptions["serializeEntry"];
  private readonly inbox: ContinuationRepairInbox;
  private readonly manifest: ContinuationRepairManifest;
  private readonly bindings: ContinuationRepairBindings;
  private readonly durability: ContinuationRepairDurability;
  private readonly runtime: ContinuationRepairRuntime;
  private readonly notifyStateChanged: () => void;

  constructor(options: ContinuationRepairCoordinatorOptions) {
    this.authority = options.authority;
    this.serializeEntry = options.serializeEntry;
    this.inbox = options.inbox;
    this.manifest = options.manifest;
    this.bindings = options.bindings;
    this.durability = options.durability;
    this.runtime = options.runtime;
    this.notifyStateChanged = options.notifyStateChanged;
  }

  async restore(input: ContinuationRepairInput): Promise<ContinuationRepairOutcome> {
    const { agent, item } = input;
    const repairContinuation = this.runtime.repair;
    if (!repairContinuation) return "failed";
    return this.serializeEntry(agent.agentId, async () => {
      if (
        this.authority.isHandoffScheduled()
        || agent.daemonGeneration !== this.authority.currentGeneration()
      ) {
        return "authority_changed";
      }
      await this.authority.assertCurrent();

      const previousRepair = await this.inbox.latest(agent.agentId);
      const entry = await this.manifest.getEntry(agent.agentId);
      const handle = this.runtime.getHandle(agent.agentId);
      const binding = await this.bindings.get(agent.agentId);
      const connection = handle?.providerConnection;
      const processIdentity = connection?.processIdentity?.trim() || null;
      const expectedPid = connection?.pid ?? handle?.pid ?? null;
      if (!entry || !handle || !binding || !entry.work_attempt_id || !entry.provider_ref
        || item.agent_id !== entry.id || item.room_id !== entry.room_id
        || item.state !== "blocked" || item.failure_code !== "provider_continuation_missing"
        || item.attempt_count !== 0 || item.provider_turn_id || item.outcome
        || binding.entry_id !== entry.id || binding.room_id !== entry.room_id
        || binding.work_attempt_id !== entry.work_attempt_id
        || binding.execution_generation_id !== entry.provider_ref.execution_generation_id
        || binding.agent_session_id !== agent.agentSessionId
        || handle.workAttemptId !== entry.work_attempt_id
        || expectedPid === null || expectedPid <= 0 || !processIdentity) {
        return "authority_changed";
      }
      const credential = await this.bindings.credentialFor(binding);
      if (!credential || credential !== agent.bearer) return "authority_changed";

      const durableContinuation = entry.provider_ref.provider_continuation_id;
      const currentContinuation = agent.providerContinuationId;
      if (!currentContinuation) return "failed";
      const previousCommittedForCurrentContinuation = Boolean(
        previousRepair
        && previousRepair.inbox_item_id === item.inbox_item_id
        && previousRepair.phase === "committed"
        && previousRepair.replacement_continuation === currentContinuation,
      );
      const previousRepairOnlyRematerialized = previousCommittedForCurrentContinuation
        && previousRepair!.missing_continuation === previousRepair!.replacement_continuation;
      if (previousCommittedForCurrentContinuation && !previousRepairOnlyRematerialized && !input.manual) {
        if (!continuationRepairExhaustionNeedsPersistence(item.last_error)) return "failed";
        await this.inbox.exhaust(
          item.inbox_item_id,
          previousRepair!.repair_id,
          CONTINUATION_REPAIR_EXHAUSTED_ERROR,
        );
        this.notifyStateChanged();
        return "failed";
      }
      const forceReplacement = previousCommittedForCurrentContinuation
        && (previousRepairOnlyRematerialized || input.manual);
      const missingContinuation = continuationRepairMissingContinuation(
        previousRepair,
        item.inbox_item_id,
        currentContinuation,
      );
      if (!missingContinuation) return "failed";
      const replacementAlreadyDurable = previousRepair?.replacement_continuation ?? null;
      const canReconcileFailedReplacement = previousRepair?.inbox_item_id === item.inbox_item_id
        && previousRepair.phase === "failed"
        && replacementAlreadyDurable !== null
        && durableContinuation === replacementAlreadyDurable
        && handle.providerContinuationId === replacementAlreadyDurable;
      if (!input.manual
        && previousRepair?.inbox_item_id === item.inbox_item_id
        && previousRepair.phase === "failed"
        && !canReconcileFailedReplacement) {
        return "failed";
      }
      const continuationIsRepairTarget = durableContinuation === missingContinuation
        || (replacementAlreadyDurable !== null && durableContinuation === replacementAlreadyDurable);
      if (!continuationIsRepairTarget
        || !sameProviderActionConnectionIdentity(entry.provider_ref.provider_connection, connection)) {
        return "authority_changed";
      }

      const repair = await this.inbox.begin({
        agent_id: entry.id,
        room_id: entry.room_id,
        inbox_item_id: item.inbox_item_id,
        daemon_generation: this.authority.currentGeneration(),
        execution_generation_id: entry.provider_ref.execution_generation_id,
        work_attempt_id: entry.work_attempt_id,
        expected_pid: expectedPid,
        expected_process_identity: processIdentity,
        missing_continuation: missingContinuation,
      });

      // A predecessor may have committed all authority-changing state and
      // crashed before releasing the inbox row. Reconcile without probing or
      // creating another provider conversation.
      if (repair.replacement_continuation
        && durableContinuation === repair.replacement_continuation
        && handle.providerContinuationId === repair.replacement_continuation) {
        await this.inbox.commit(repair.repair_id, repair.replacement_continuation, true);
        return "restored";
      }

      if (durableContinuation !== repair.missing_continuation
        || handle.providerContinuationId !== repair.missing_continuation) {
        return "authority_changed";
      }

      try {
        const result = await repairContinuation(handle, {
          workAttemptId: entry.work_attempt_id,
          expectedProviderContinuationId: repair.missing_continuation,
          checkpointedReplacementProviderContinuationId: repair.replacement_continuation,
          forceReplacement,
          cwd: entry.workspace_path ?? "",
          launchPolicy: entry.provider_launch_policy,
          model: entry.model,
          reasoningEffort: entry.reasoning_effort ?? null,
        }, {
          checkpointReplacement: async (replacementContinuation) => {
            await this.authority.assertCurrent();
            const checkpointed = await this.inbox.checkpointReplacement(
              repair.repair_id,
              replacementContinuation,
            );
            const current = await this.manifest.getEntry(entry.id);
            const currentHandle = this.runtime.getHandle(entry.id);
            if (!current || currentHandle !== handle
              || current.work_attempt_id !== repair.work_attempt_id
              || current.provider_ref?.execution_generation_id !== repair.execution_generation_id
              || current.provider_ref.provider_continuation_id !== repair.missing_continuation
              || !sameProviderActionConnectionIdentity(current.provider_ref.provider_connection, handle.providerConnection)) {
              throw new Error("Provider authority changed before the replacement conversation could be committed.");
            }
            const attempt = await this.durability.getAttempt(repair.work_attempt_id);
            if (attempt.checkpoints.at(-1)?.provider_continuation_id !== replacementContinuation) {
              await this.durability.checkpoint(repair.work_attempt_id, {
                room_cursor: null,
                provider_continuation_id: replacementContinuation,
              });
            }
            await this.manifest.updateEntry(entry.id, (candidate) => {
              if (candidate.work_attempt_id !== repair.work_attempt_id
                || candidate.provider_ref?.execution_generation_id !== repair.execution_generation_id
                || candidate.provider_ref.provider_continuation_id !== repair.missing_continuation
                || !sameProviderActionConnectionIdentity(candidate.provider_ref.provider_connection, handle.providerConnection)) {
                throw new Error("Provider authority changed during replacement conversation persistence.");
              }
              return {
                ...candidate,
                provider_ref: {
                  ...candidate.provider_ref,
                  provider_continuation_id: checkpointed.replacement_continuation!,
                },
              };
            });
          },
        });

        if (result.handle.workAttemptId !== repair.work_attempt_id
          || result.handle.pid !== repair.expected_pid
          || !sameProviderActionConnectionIdentity(result.handle.providerConnection, connection)
          || result.previousProviderContinuationId !== repair.missing_continuation) {
          throw new Error("Continuation repair returned a different provider process or work attempt.");
        }
        const continuityReset = result.outcome === "replaced";
        if (continuityReset) {
          const committedEntry = await this.manifest.getEntry(entry.id);
          if (committedEntry?.provider_ref?.provider_continuation_id !== result.replacementProviderContinuationId) {
            throw new Error("Replacement conversation was not durable before handle promotion.");
          }
          await this.runtime.promote(entry.id, result.handle, repair.execution_generation_id);
        }
        await this.inbox.commit(
          repair.repair_id,
          result.replacementProviderContinuationId,
          continuityReset,
        );
        this.notifyStateChanged();
        return continuityReset ? "replaced" : "restored";
      } catch (error) {
        const detail = redactCredentialText(
          error instanceof Error ? error.message : "Conversation restoration failed.",
        ).value;
        await this.inbox.fail(
          repair.repair_id,
          `Couldn't restore this agent's provider conversation. ${detail}`,
        ).catch(() => undefined);
        this.notifyStateChanged();
        return "failed";
      }
    });
  }
}

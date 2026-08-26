import type { SupervisedIngressAgent } from "./supervised-agent-delivery.js";
import type {
  SupervisedEffectRecord,
  SupervisedInboxItem,
  SupervisedProviderTurnBinding,
} from "./supervised-agent-inbox-store.js";
import type { DaemonToolAgentSession, SupervisedToolRuntime } from "./supervised-tool-runtime.js";
import type { DaemonManifestEntry } from "./types.js";
import type { WorkerSessionBinding } from "./worker-binding-store.js";

export type BoundedEffectCoordinates = {
  entryId: string;
  workAttemptId: string;
  executionGenerationId: string;
  daemonGeneration: number;
  providerTurnId: string;
};

export type PrepareBoundedEffectInput = BoundedEffectCoordinates & {
  mcpRequestId: string;
  toolName: string;
  input: unknown;
  mutation: boolean;
};

export type ExecuteBoundedToolInput = BoundedEffectCoordinates & {
  mcpRequestId: string;
  toolName: string;
  input: unknown;
};

export type CompleteBoundedEffectInput = BoundedEffectCoordinates & {
  effectId: string;
  result?: unknown;
  error?: string;
};

export type BoundedEffectContext = {
  entry: Pick<DaemonManifestEntry, "id" | "room_id" | "provider" | "workspace_path">;
  agent: Pick<SupervisedIngressAgent,
    "agentSessionId" | "bearer" | "apiUrl" | "workAttemptId" |
    "executionGenerationId" | "providerContinuationId"
  >;
  binding: Pick<WorkerSessionBinding, "credential_ref">;
  active: {
    inboxItemId: string;
    sourceMessageId: string;
    phase: "dispatching" | "responding" | "publishing";
  };
  inbox: Pick<SupervisedInboxItem, "inbox_item_id" | "provider_turn_id">;
  providerTurnBinding: Pick<SupervisedProviderTurnBinding, "origin_execution_generation_id">;
};

export type BoundedWorkerAuthorization = {
  agentSessionId: string;
  bearer: string;
  bearerId: string;
  roomId: string;
  agentKey: string;
  agentSession?: DaemonToolAgentSession;
};

type CommitFence = (commit: () => Promise<void>) => Promise<void>;

export type BoundedEffectJournalPort = {
  prepare(input: {
    agent_id: string;
    room_id: string;
    execution_generation_id: string;
    work_attempt_id: string;
    current_execution_generation_id: string;
    provider_continuation_id: string;
    provider_turn_id: string;
    mcp_request_id: string;
    tool_name: string;
    request: unknown;
    mutation: boolean;
  }, commitFence: CommitFence): Promise<{ created: boolean; effect: SupervisedEffectRecord }>;
  markExecuting(input: {
    effect_id: string;
    agent_id: string;
    room_id: string;
    execution_generation_id: string;
    work_attempt_id: string;
    current_execution_generation_id: string;
    provider_continuation_id: string;
    provider_turn_id: string;
  }, commitFence: CommitFence): Promise<SupervisedEffectRecord>;
  complete(input: {
    effect_id: string;
    result?: unknown;
    error?: string;
    expected: {
      agent_id: string;
      work_attempt_id: string;
      provider_turn_id: string | null;
    };
  }, commitFence: CommitFence): Promise<SupervisedEffectRecord>;
};

export type BoundedRoomMovePort = {
  prepare(input: {
    agent_id: string;
    room_id: string;
    effect_execution_generation_id: string;
    provider_turn_id: string;
    mcp_request_id: string;
    request: unknown;
    destination_room_id: string;
    daemon_generation: number;
    work_attempt_id: string;
    execution_generation_id: string;
    provider_continuation_id: string;
    agent_session_id: string;
    activating_inbox_item_id: string;
  }, commitFence: CommitFence): Promise<{ created: boolean; effect: SupervisedEffectRecord }>;
};

export type BoundedEffectCoordinatorOptions = {
  context: {
    exactActive(input: BoundedEffectCoordinates): Promise<BoundedEffectContext>;
  };
  entries: {
    get(entryId: string): Promise<Pick<DaemonManifestEntry, "id" | "provider" | "work_attempt_id"> | null | undefined>;
  };
  authorizations: {
    get(entryId: string): BoundedWorkerAuthorization | undefined;
  };
  journal: BoundedEffectJournalPort;
  roomMoves: BoundedRoomMovePort;
  runtime: {
    load(): Promise<SupervisedToolRuntime>;
  };
  /** Retains the daemon's completion seam used by checkpoint fault injection. */
  executionCompletion: {
    complete(input: CompleteBoundedEffectInput, admittedDaemonExecution: true): Promise<{ completed: true }>;
  };
  authority: {
    assertCurrent(): Promise<void>;
    currentGeneration(): number;
    fenceCommit(commit: () => Promise<void>): Promise<void>;
    fenceAdmittedTransitionCommit(commit: () => Promise<void>): Promise<void>;
  };
  policy: {
    structuredRoomTurnCompletion(value: unknown): unknown | null;
  };
};

/** Narrow shutdown/handoff surface consumed by the daemon lifecycle owner. */
export type BoundedEffectHandoffPort = {
  drainJournalReservations(): Promise<void>;
  drainExternalExecutions(): Promise<void>;
};

/**
 * Owns bounded tool orchestration and its two deliberately distinct handoff
 * reservation classes. Journal work is short and durable; external execution
 * may be long-running but must settle its admitted journal before handoff.
 */
export class BoundedEffectCoordinator implements BoundedEffectHandoffPort {
  private readonly journalReservations = new Set<Promise<void>>();
  private readonly externalExecutions = new Set<Promise<void>>();

  constructor(private readonly options: BoundedEffectCoordinatorOptions) {}

  prepare(input: PrepareBoundedEffectInput): Promise<Record<string, unknown>> {
    return this.reserveJournal(() => this.prepareOnce(input));
  }

  async execute(input: ExecuteBoundedToolInput): Promise<Record<string, unknown>> {
    return this.reserveExecution(() => this.executeOnce(input));
  }

  async executeOnce(input: ExecuteBoundedToolInput): Promise<Record<string, unknown>> {
    const runtime = await this.options.runtime.load();
    const mutation = runtime.supervisedToolIsMutation(input.toolName);
    const prepared = await this.reserveJournal(() => this.prepareOnce({ ...input, mutation }));
    const roomId = typeof prepared.room_id === "string" ? prepared.room_id : "";
    if (prepared.state === "completed") return prepared;
    if (prepared.state === "uncertain") {
      return { state: "completed", room_id: roomId, result: this.supervisedInstruction(
        "This mutating tool may already have completed, but its result was not durably checkpointed. Verify the external state before issuing a new request; this exact request will not be repeated automatically.",
        { code: "SUPERVISED_EFFECT_OUTCOME_UNCERTAIN", effect_id: prepared.effect_id, detail: prepared.error },
      ) };
    }
    if (prepared.action === "use_final_answer") {
      const context = await this.options.context.exactActive(input);
      return { state: "completed", room_id: roomId, result: this.supervisedInstruction(
        context.entry.provider === "cursor"
          ? "Do not send the activating room reply with a message tool. Keep working, then record the one public answer with complete_room_turn; Cursor's aggregate final text is live evidence only."
          : "Do not send the activating room reply with a message tool. Return it as your final answer; the daemon will publish it exactly once.",
        { code: "USE_FINAL_ANSWER", source_message_id: prepared.source_message_id },
      ) };
    }
    if (prepared.action === "room_move_prepared") {
      const context = await this.options.context.exactActive(input);
      return { state: "completed", room_id: roomId, result: this.supervisedInstruction(
        context.entry.provider === "cursor"
          ? "The room move is prepared. Finish the work, then call complete_room_turn with the public response; the daemon will publish that proposal and then move the agent."
          : "The room move is prepared. Finish this turn normally; the daemon will publish the activating response and then move the agent.",
        { code: "ROOM_MOVE_PREPARED", destination_room: prepared.destination_room },
      ) };
    }
    if (prepared.action !== "execute" || typeof prepared.effect_id !== "string") {
      throw new Error("The supervised effect journal returned an unsupported execution state.");
    }

    // Re-resolve exact authority after journal preparation and before any I/O.
    const context = await this.options.context.exactActive(input);
    const authorization = this.options.authorizations.get(context.entry.id);
    const session = authorization?.agentSession;
    if (!authorization || !session
      || authorization.agentSessionId !== context.agent.agentSessionId
      || authorization.bearer !== context.agent.bearer
      || authorization.bearerId !== context.binding.credential_ref
      || authorization.roomId !== context.entry.room_id
      || session.session_id !== context.agent.agentSessionId
      || session.room_id !== context.entry.room_id
      || session.runtime !== context.entry.provider
      || session.agent_key !== authorization.agentKey
      || session.agent_instance_id !== `daemon:${context.entry.id}`) {
      throw new Error("The exact server-issued worker identity is unavailable for this supervised tool execution.");
    }
    let executed: Awaited<ReturnType<SupervisedToolRuntime["executeDaemonTool"]>>;
    try {
      executed = await runtime.executeDaemonTool({
        provider: context.entry.provider,
        toolName: input.toolName,
        input: input.input,
        requestId: input.mcpRequestId,
        roomId: context.entry.room_id,
        apiUrl: context.agent.apiUrl,
        bearer: context.agent.bearer,
        cwd: context.entry.workspace_path ?? "",
        agentSession: session,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        await this.reserveJournal(() => this.options.executionCompletion.complete({
          ...input,
          effectId: prepared.effect_id as string,
          error: detail,
        }, true));
      } catch {
        // Preserve the execution error. An unconfirmed journal completion is
        // deliberately never redriven as a mutation by the same request id.
      }
      throw error;
    }
    // Execution and checkpointing are separate truth boundaries. If the
    // external effect succeeded but this write fails, leave the journal in
    // executing/uncertain state; never rewrite the real success as failure.
    await this.reserveJournal(() => this.options.executionCompletion.complete({
      ...input,
      effectId: prepared.effect_id as string,
      result: executed.durableResult,
    }, true));
    return { state: "completed", room_id: context.entry.room_id, result: executed.liveResult };
  }

  async prepareOnce(input: PrepareBoundedEffectInput): Promise<Record<string, unknown>> {
    if (!input.mcpRequestId.trim() || !input.toolName.trim()) {
      throw new Error("A supervised effect requires MCP request and tool identities.");
    }
    const context = await this.options.context.exactActive(input);
    const withExactRoom = (result: Record<string, unknown>): Record<string, unknown> => ({
      ...result,
      room_id: context.entry.room_id,
    });
    const args = input.input && typeof input.input === "object" && !Array.isArray(input.input)
      ? input.input as Record<string, unknown>
      : {};
    if (input.toolName === "complete_room_turn") {
      if (context.entry.provider !== "cursor") {
        throw new Error("The structured room-turn completion channel is reserved for supervised Cursor turns.");
      }
      if (!this.options.policy.structuredRoomTurnCompletion(input.input)) {
        throw new Error("The supervised room-turn completion proposal is malformed.");
      }
    }
    if (input.toolName === "join_room") {
      const destination = typeof args.name === "string" ? args.name.trim() : "";
      if (!destination || destination.length > 1_024
        || /[\u0000-\u001f\u007f]/.test(destination)
        || destination === context.entry.room_id) {
        throw new Error("A room move requires a different valid destination room.");
      }
      const prepared = await this.options.roomMoves.prepare({
        agent_id: input.entryId,
        room_id: context.entry.room_id,
        effect_execution_generation_id: context.providerTurnBinding.origin_execution_generation_id,
        provider_turn_id: context.inbox.provider_turn_id!,
        mcp_request_id: input.mcpRequestId,
        request: input.input,
        destination_room_id: destination,
        daemon_generation: this.options.authority.currentGeneration(),
        work_attempt_id: context.agent.workAttemptId,
        execution_generation_id: context.agent.executionGenerationId,
        provider_continuation_id: context.agent.providerContinuationId!,
        agent_session_id: context.agent.agentSessionId,
        activating_inbox_item_id: context.inbox.inbox_item_id,
      }, (commit) => this.options.authority.fenceCommit(commit));
      if (prepared.effect.state === "completed") {
        return withExactRoom({ state: "completed", result: prepared.effect.result });
      }
      if (prepared.effect.state === "failed") {
        throw new Error(prepared.effect.error || "The prior supervised room move failed.");
      }
      return withExactRoom({
        state: "prepared",
        effect_id: prepared.effect.effect_id,
        action: "room_move_prepared",
        destination_room: destination,
      });
    }
    const prepared = await this.options.journal.prepare({
      agent_id: input.entryId,
      room_id: context.entry.room_id,
      execution_generation_id: context.providerTurnBinding.origin_execution_generation_id,
      work_attempt_id: context.agent.workAttemptId,
      current_execution_generation_id: context.agent.executionGenerationId,
      provider_continuation_id: context.agent.providerContinuationId!,
      provider_turn_id: context.inbox.provider_turn_id!,
      mcp_request_id: input.mcpRequestId,
      tool_name: input.toolName,
      request: input.input,
      mutation: input.mutation,
    }, (commit) => this.options.authority.fenceCommit(commit));
    if (prepared.effect.state === "completed") {
      return withExactRoom({ state: "completed", result: prepared.effect.result });
    }
    if (!prepared.created) {
      if (prepared.effect.state === "failed") {
        throw new Error(prepared.effect.error || "The prior supervised effect failed.");
      }
      if (prepared.effect.state === "uncertain") {
        return withExactRoom({
          state: "uncertain",
          effect_id: prepared.effect.effect_id,
          mutation: prepared.effect.mutation,
          error: prepared.effect.error || "The mutating tool outcome is uncertain.",
        });
      }
      if (prepared.effect.state === "executing") {
        throw new Error("The prior supervised effect is still executing; refusing a duplicate side effect.");
      }
    }
    const targetMessage = typeof args.thread_parent_id === "string"
      ? args.thread_parent_id
      : typeof args.reply_to === "string"
        ? args.reply_to
        : null;
    if ((input.toolName === "send_message" || input.toolName === "send_thread_message")
      && targetMessage === context.active.sourceMessageId) {
      return withExactRoom({
        state: "prepared",
        effect_id: prepared.effect.effect_id,
        action: "use_final_answer",
        source_message_id: context.active.sourceMessageId,
      });
    }
    const executing = await this.options.journal.markExecuting({
      effect_id: prepared.effect.effect_id,
      agent_id: input.entryId,
      room_id: context.entry.room_id,
      execution_generation_id: context.providerTurnBinding.origin_execution_generation_id,
      work_attempt_id: context.agent.workAttemptId,
      current_execution_generation_id: context.agent.executionGenerationId,
      provider_continuation_id: context.agent.providerContinuationId!,
      provider_turn_id: context.inbox.provider_turn_id!,
    }, (commit) => this.options.authority.fenceCommit(commit));
    if (executing.state !== "executing") {
      throw new Error("The supervised effect did not acquire durable execution authority.");
    }
    return withExactRoom({
      state: "prepared",
      effect_id: prepared.effect.effect_id,
      action: "execute",
      mutation: input.mutation,
    });
  }

  complete(input: CompleteBoundedEffectInput): Promise<{ completed: true }> {
    return this.reserveJournal(() => this.completeOnce(input));
  }

  async completeOnce(
    input: CompleteBoundedEffectInput,
    admittedDaemonExecution = false,
  ): Promise<{ completed: true }> {
    await this.options.authority.assertCurrent();
    if (!Number.isSafeInteger(input.daemonGeneration)
      || input.daemonGeneration !== this.options.authority.currentGeneration()) {
      throw new Error("The supervised effect completion belongs to a stale daemon generation.");
    }
    const entry = await this.options.entries.get(input.entryId);
    if (!entry || entry.work_attempt_id !== input.workAttemptId) {
      throw new Error("The supervised effect completion lost its exact agent work authority.");
    }
    const callerProviderTurnId = input.providerTurnId.trim() || null;
    if (entry.provider === "cursor" && !callerProviderTurnId) {
      throw new Error("Cursor supervised effect completion requires its exact provider turn capability.");
    }
    await this.options.journal.complete({
      effect_id: input.effectId,
      result: input.result,
      error: input.error,
      expected: {
        agent_id: input.entryId,
        work_attempt_id: input.workAttemptId,
        provider_turn_id: callerProviderTurnId,
      },
    }, (commit) => admittedDaemonExecution
      ? this.options.authority.fenceAdmittedTransitionCommit(commit)
      : this.options.authority.fenceCommit(commit));
    return { completed: true };
  }

  reserveJournal<T>(operation: () => Promise<T>): Promise<T> {
    return this.reserve(this.journalReservations, operation);
  }

  reserveExecution<T>(operation: () => Promise<T>): Promise<T> {
    return this.reserve(this.externalExecutions, operation);
  }

  /** Handoff/normal shutdown drain only admitted journal transactions here. */
  async drainJournalReservations(): Promise<void> {
    await Promise.all([...this.journalReservations]);
  }

  /** Prepare-handoff additionally waits for admitted external tool executions. */
  async drainExternalExecutions(): Promise<void> {
    await Promise.all([...this.externalExecutions]);
  }

  private supervisedInstruction(instruction: string, data: Record<string, unknown>): Record<string, unknown> {
    const payload = { ...data, instruction };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  }

  private reserve<T>(reservations: Set<Promise<void>>, operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const reservation = new Promise<void>((resolve) => { release = resolve; });
    reservations.add(reservation);
    let result: Promise<T>;
    try {
      result = operation();
    } catch (error) {
      reservations.delete(reservation);
      release();
      throw error;
    }
    return result.finally(() => {
      reservations.delete(reservation);
      release();
    });
  }
}

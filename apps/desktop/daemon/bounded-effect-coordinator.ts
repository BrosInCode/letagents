import type { DatabaseSync } from "node:sqlite";
import { validReplyGifIntent } from "../../../shared/room-expressions.mjs";
import { SUGGESTED_REPLY_MAX_CHARS, validReplySuggestionIntent } from "../../../shared/suggested-reply.mjs";
import { validReplyAttachmentsRequest } from "../../../shared/message-attachments.mjs";
import { CODEX_READ_ONLY_ROOM_TOOLS } from "../../../shared/codex-read-only-room-tools.mjs";
import { isLocalRoomApi } from "../../../shared/room-api-origin.mjs";
import {
  BOUNDED_MCP_EFFECT_KIND,
  BOUNDED_MCP_MAX_READ_ATTEMPTS,
  EffectClaimRefusedError,
  isProvenBoundedMutationPreDispatchOr4xxError,
  type EffectExecutor,
  type EffectHandler,
  type EffectRecord,
} from "./effect-journal/index.js";
import type { ReplyAttachmentSnapshotInput } from "./reply-attachment-spool.js";
import type { SupervisedIngressAgent } from "./supervised-agent-delivery.js";
import { EffectAuthorityError } from "./supervised-agent-inbox-store/effect-values.js";
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
  uncertain?: boolean;
};

export type BoundedEffectContext = {
  entry: Pick<DaemonManifestEntry, "id" | "room_id" | "provider" | "workspace_path" | "permission_profile_id">;
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

export type BoundedEffectClaimAuthority = {
  agent_id: string;
  room_id: string;
  execution_generation_id: string;
  work_attempt_id: string;
  current_execution_generation_id: string;
  provider_continuation_id: string;
  provider_turn_id: string;
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
    daemon_generation?: number;
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
    daemon_generation?: number;
  }, commitFence: CommitFence): Promise<SupervisedEffectRecord>;
  authorizeClaimInTransaction?: (
    database: DatabaseSync,
    effectRecord: EffectRecord,
    input: BoundedEffectClaimAuthority,
  ) => string | null;
  complete(input: {
    effect_id: string;
    result?: unknown;
    error?: string;
    uncertain?: boolean;
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
  /** Copies the files an agent attaches to its final reply; absent in daemons without a spool. */
  replyAttachments?: {
    snapshot(input: ReplyAttachmentSnapshotInput): Promise<{ files: Array<{ spool_id: string }> | null }>;
    /** Drop the copies a newly journaled choice replaced. */
    keepOnly(inboxItemId: string, spoolIds: readonly string[]): Promise<void>;
  };
  /** Single process-wide effect executor; when present, on-demand tool executions run through it. */
  executor?: () => Pick<EffectExecutor, "runEffect" | "hasHandler"> | null;
  /** Reads the updated unified effect record after settlement inside `EffectExecutor`. */
  getEffect?: (effectId: string) => EffectRecord | null;
};

type ActiveOnDemandExecution = {
  input: ExecuteBoundedToolInput;
  runtime: SupervisedToolRuntime;
  mutation: boolean;
  claimAuthority: BoundedEffectClaimAuthority;
  roomId: string;
  liveResult: unknown;
  thrownError: unknown;
  hasThrownError: boolean;
  uncertainUnrecorded: boolean;
};

async function raceWithAbortSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<{ aborted: true } | { aborted: false; value: T }> {
  if (signal.aborted) {
    void operation.catch(() => {});
    return { aborted: true };
  }
  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<{ aborted: true }>((resolve) => {
    onAbort = () => resolve({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([
      operation.then((value) => ({ aborted: false as const, value })),
      abortPromise,
    ]);
    if (result.aborted) {
      void operation.catch(() => {});
    }
    return result;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Whether an agent is a Codex agent whose saved access level is Read-only. */
export function codexAgentIsReadOnly(entry: Pick<DaemonManifestEntry, "provider" | "permission_profile_id">): boolean {
  return entry.provider.trim().toLowerCase() === "codex" && entry.permission_profile_id?.trim() === "read_only";
}

/**
 * Why a room tool is refused for a Codex agent whose access level is
 * Read-only. Null for a tool it may use, and for every other agent.
 *
 * The owner's card for the level says what the agent can do in the room: read
 * it and post in it. Codex is told the same list, but that part is a setting
 * of Codex, and what Codex does with it can change. Every room tool call of
 * such an agent passes here, so the limit is kept here whatever Codex asked
 * for. The level is the one the owner saved: it is the one their card shows,
 * and it holds from the moment it is saved, also for a process that still
 * runs with an earlier level. A tool is allowed only by its exact name, so a
 * tool the room server gains later is refused until it is named.
 */
export function readOnlyRoomToolRefusal(
  entry: Pick<DaemonManifestEntry, "provider" | "permission_profile_id">,
  toolName: string,
): string | null {
  if (!codexAgentIsReadOnly(entry)) return null;
  if (CODEX_READ_ONLY_ROOM_TOOLS.has(toolName)) return null;
  const shown = JSON.stringify(toolName.replace(/[^\x20-\x7e]/g, "?").slice(0, 64));
  return `Read-only access does not allow the room tool ${shown}. This agent can read the room and post in it. `
    + "It cannot change the task board, join rooms or submit reviews. Its owner can choose another access level.";
}

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
  private readonly activeRequests = new Map<string, {
    payload: string;
    result: Promise<Record<string, unknown>>;
  }>();
  private readonly activeOnDemand = new Map<string, ActiveOnDemandExecution>();

  constructor(private readonly options: BoundedEffectCoordinatorOptions) {}

  /**
   * Builds the `EffectHandler` registered on the daemon's single `EffectExecutor`
   * under `kind = "bounded_mcp_effect"` (`autoPump: false` — on-demand only).
   */
  createExecutorHandler(): EffectHandler {
    return {
      retryable: true,
      autoPump: false,
      defaultMaxAttempts: BOUNDED_MCP_MAX_READ_ATTEMPTS,
      authorizeClaim: (database, effectRecord) => {
        const invocation = this.activeOnDemand.get(effectRecord.id);
        if (!invocation) {
          return "The supervised bounded MCP effect requires an active on-demand execution caller.";
        }
        if (this.options.journal.authorizeClaimInTransaction) {
          return this.options.journal.authorizeClaimInTransaction(database, effectRecord, invocation.claimAuthority);
        }
        return null;
      },
      execute: async (claimed, ctx) => {
        const invocation = this.activeOnDemand.get(claimed.id);
        if (!invocation) {
          return {
            status: "failed",
            error: "The supervised bounded MCP effect lost its active on-demand caller before execution.",
          };
        }
        if (ctx.signal.aborted) {
          const error = new Error("The daemon shut down before the supervised tool began executing.");
          invocation.thrownError = error;
          invocation.hasThrownError = true;
          return { status: "failed", error: error.message };
        }
        let context: BoundedEffectContext;
        try {
          context = await this.options.context.exactActive(invocation.input);
        } catch (error) {
          invocation.thrownError = error;
          invocation.hasThrownError = true;
          return {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        const refusedNow = readOnlyRoomToolRefusal(context.entry, invocation.input.toolName);
        if (refusedNow) {
          invocation.thrownError = new Error(refusedNow);
          invocation.hasThrownError = true;
          return { status: "failed", error: refusedNow };
        }
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
          const error = new Error("The exact server-issued worker identity is unavailable for this supervised tool execution.");
          invocation.thrownError = error;
          invocation.hasThrownError = true;
          return { status: "failed", error: error.message };
        }
        if (ctx.signal.aborted) {
          const error = new Error("The daemon shut down before the supervised tool began executing.");
          invocation.thrownError = error;
          invocation.hasThrownError = true;
          return { status: "failed", error: error.message };
        }
        try {
          const raced = await raceWithAbortSignal(
            invocation.runtime.executeDaemonTool({
              provider: context.entry.provider,
              toolName: invocation.input.toolName,
              input: invocation.input.input,
              requestId: isLocalRoomApi(context.agent.apiUrl) ? claimed.id : invocation.input.mcpRequestId,
              effectId: claimed.id,
              signal: ctx.signal,
              roomId: context.entry.room_id,
              apiUrl: context.agent.apiUrl,
              bearer: context.agent.bearer,
              cwd: context.entry.workspace_path ?? "",
              agentSession: session,
            }),
            ctx.signal,
          );
          if (raced.aborted) {
            if (invocation.mutation) {
              const detail = "The daemon shut down while the mutating tool was executing. It may have completed; verify external state before repeating it.";
              invocation.thrownError = new Error(detail);
              invocation.hasThrownError = true;
              return { status: "uncertain", error: detail };
            }
            const detail = "The daemon shut down while the read-only tool was executing.";
            invocation.thrownError = new Error(detail);
            invocation.hasThrownError = true;
            return { status: "retry", retryAfterMs: 0, error: detail };
          }
          invocation.roomId = context.entry.room_id;
          invocation.liveResult = raced.value.liveResult;
          return { status: "completed", outcome: raced.value.durableResult };
        } catch (error) {
          invocation.thrownError = error;
          invocation.hasThrownError = true;
          const detail = error instanceof Error ? error.message : String(error);
          if (invocation.mutation) {
            if (!ctx.signal.aborted && isProvenBoundedMutationPreDispatchOr4xxError(error)) {
              return { status: "failed", error: detail };
            }
            return {
              status: "uncertain",
              error: ctx.signal.aborted
                ? "The daemon shut down while the mutating tool was executing. It may have completed; verify external state before repeating it."
                : detail,
            };
          }
          if (ctx.signal.aborted) {
            return { status: "retry", retryAfterMs: 0, error: detail };
          }
          return { status: "failed", error: detail };
        }
      },
      settle: async (claimed, result, defaultSettle) => {
        const invocation = this.activeOnDemand.get(claimed.id);
        if (!invocation) return defaultSettle();
        if (result.status === "completed") {
          // Execution and checkpointing are separate truth boundaries. If the
          // external effect succeeded but this write fails, leave the journal in
          // executing state; never rewrite the real success as failure.
          await this.reserveJournal(() => this.options.executionCompletion.complete({
            ...invocation.input,
            effectId: claimed.id,
            result: result.outcome,
          }, true));
          return this.options.getEffect?.(claimed.id) ?? {
            ...claimed,
            state: "completed",
            outcome: result.outcome ?? null,
            last_error: null,
          };
        }
        if (result.status === "failed" || result.status === "uncertain") {
          let settledInJournal = false;
          try {
            await this.reserveJournal(() => this.options.executionCompletion.complete({
              ...invocation.input,
              effectId: claimed.id,
              error: result.error,
              ...(result.status === "uncertain" ? { uncertain: true } : {}),
            }, true));
            settledInJournal = true;
          } catch {
            // Preserve the execution error. An unconfirmed journal completion is
            // deliberately never redriven as a mutation by the same request id.
            if (result.status === "uncertain") {
              invocation.uncertainUnrecorded = true;
            }
          }
          return this.options.getEffect?.(claimed.id) ?? {
            ...claimed,
            state: settledInJournal ? result.status : claimed.state,
            last_error: settledInJournal ? result.error : claimed.last_error,
          };
        }
        return this.reserveJournal(async () => defaultSettle());
      },
    };
  }

  prepare(input: PrepareBoundedEffectInput): Promise<Record<string, unknown>> {
    return this.reserveJournal(() => this.prepareOnce(input));
  }

  async execute(input: ExecuteBoundedToolInput): Promise<Record<string, unknown>> {
    const key = JSON.stringify([
      input.entryId, input.workAttemptId, input.executionGenerationId,
      input.daemonGeneration, input.providerTurnId, input.mcpRequestId,
    ]);
    const payload = JSON.stringify([input.toolName, input.input]);
    const active = this.activeRequests.get(key);
    if (active) {
      if (active.payload !== payload) {
        throw new Error("A supervised MCP request id was reused for a different effect; refusing ambiguous execution.");
      }
      // Sharing an admitted execution must not grant a stale turn authority.
      await this.options.context.exactActive(input);
      return active.result;
    }
    // A live retry is not crash recovery. Keep it out of prepareEffect until
    // the original execution AND its result checkpoint have settled.
    const result = this.reserveExecution(() => this.executeOnce(input)).finally(() => {
      this.activeRequests.delete(key);
    });
    this.activeRequests.set(key, { payload, result });
    return result;
  }

  async executeOnce(input: ExecuteBoundedToolInput): Promise<Record<string, unknown>> {
    const runtime = await this.options.runtime.load();
    const mutation = runtime.supervisedToolIsMutation(input.toolName);
    const executor = this.activeExecutor();
    const prepared = await this.reserveJournal(() => this.prepareOnce(
      { ...input, mutation },
      { claimForExecution: executor === null },
    ));
    const roomId = typeof prepared.room_id === "string" ? prepared.room_id : "";
    if (prepared.state === "completed") return prepared;
    if (prepared.state === "uncertain") {
      return this.uncertainToolResponse(roomId, String(prepared.effect_id ?? ""), prepared.error);
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

    if (executor) {
      const effectId = prepared.effect_id;
      const claimAuthority = prepared.claim_authority as BoundedEffectClaimAuthority;
      const invocation: ActiveOnDemandExecution = {
        input,
        runtime,
        mutation,
        claimAuthority,
        roomId,
        liveResult: undefined,
        thrownError: undefined,
        hasThrownError: false,
        uncertainUnrecorded: false,
      };
      this.activeOnDemand.set(effectId, invocation);
      let settled: EffectRecord;
      try {
        settled = await executor.runEffect(effectId);
      } catch (error) {
        if (error instanceof EffectClaimRefusedError) {
          throw new EffectAuthorityError(error.message);
        }
        throw error;
      } finally {
        this.activeOnDemand.delete(effectId);
      }
      if (settled.state === "uncertain") {
        return this.uncertainToolResponse(roomId, effectId, settled.last_error);
      }
      if (invocation.hasThrownError) {
        if (invocation.uncertainUnrecorded) {
          throw this.unrecordedUncertainError(invocation.thrownError);
        }
        throw invocation.thrownError;
      }
      if (settled.state === "failed") {
        throw new Error(settled.last_error ?? "The supervised effect failed before execution.");
      }
      if (settled.state !== "completed") {
        throw new Error(`The supervised effect entered unexpected state ${settled.state}.`);
      }
      return {
        state: "completed",
        room_id: invocation.roomId,
        result: invocation.liveResult !== undefined ? invocation.liveResult : settled.outcome,
      };
    }

    // Re-resolve exact authority after journal preparation and before any I/O.
    const context = await this.options.context.exactActive(input);
    // The entry was loaded again: its owner may have saved Read-only since this call was prepared.
    // The level holds from the moment it is saved, so the tool is not run, and its effect is closed as failed.
    const refusedNow = readOnlyRoomToolRefusal(context.entry, input.toolName);
    if (refusedNow) {
      try {
        await this.reserveJournal(() => this.options.executionCompletion.complete({
          ...input,
          effectId: prepared.effect_id as string,
          error: refusedNow,
        }, true));
      } catch {
        // The refusal stands. An effect that could not be closed is never run again by the same request id.
      }
      throw new Error(refusedNow);
    }
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
        requestId: isLocalRoomApi(context.agent.apiUrl) ? prepared.effect_id : input.mcpRequestId,
        effectId: prepared.effect_id,
        roomId: context.entry.room_id,
        apiUrl: context.agent.apiUrl,
        bearer: context.agent.bearer,
        cwd: context.entry.workspace_path ?? "",
        agentSession: session,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const uncertain = mutation && !isProvenBoundedMutationPreDispatchOr4xxError(error);
      let settledUncertain = false;
      try {
        await this.reserveJournal(() => this.options.executionCompletion.complete({
          ...input,
          effectId: prepared.effect_id as string,
          error: detail,
          ...(uncertain ? { uncertain: true } : {}),
        }, true));
        settledUncertain = uncertain;
      } catch {
        // Preserve the execution error. An unconfirmed journal completion is
        // deliberately never redriven as a mutation by the same request id.
      }
      if (settledUncertain) {
        return this.uncertainToolResponse(context.entry.room_id, prepared.effect_id as string, detail);
      }
      if (uncertain) {
        throw this.unrecordedUncertainError(error);
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

  async prepareOnce(
    input: PrepareBoundedEffectInput,
    options: { claimForExecution?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const claimForExecution = options.claimForExecution ?? true;
    if (!input.mcpRequestId.trim() || !input.toolName.trim()) {
      throw new Error("A supervised effect requires MCP request and tool identities.");
    }
    const context = await this.options.context.exactActive(input);
    // Before anything is journaled or run: a refused call leaves no effect behind.
    const refusal = readOnlyRoomToolRefusal(context.entry, input.toolName);
    if (refusal) throw new Error(refusal);
    const withExactRoom = (result: Record<string, unknown>): Record<string, unknown> => ({
      ...result,
      room_id: context.entry.room_id,
    });
    const args = input.input && typeof input.input === "object" && !Array.isArray(input.input)
      ? input.input as Record<string, unknown>
      : {};
    if (input.toolName === "set_reply_thread"
      && (!input.input || typeof input.input !== "object" || Array.isArray(input.input) || Object.keys(input.input).length !== 0)) {
      throw new Error("set_reply_thread takes an empty object; the active turn determines its thread.");
    }
    if (input.toolName === "set_reply_gif" && !validReplyGifIntent(input.input)) throw new Error("Invalid GIF reply intent.");
    if (input.toolName === "set_reply_suggestion" && !validReplySuggestionIntent(input.input)) {
      throw new Error(`set_reply_suggestion takes { text: 1 to ${SUGGESTED_REPLY_MAX_CHARS} characters }, or { text: null } to clear it.`);
    }
    let request = input.input;
    if (input.toolName === "set_reply_attachments") {
      if (isLocalRoomApi(context.agent.apiUrl)) throw new Error("Reply attachments need a cloud room.");
      if (!validReplyAttachmentsRequest(input.input)) {
        throw new Error("set_reply_attachments takes { files: [1 to 4 workspace paths] }, or { files: null } to clear them.");
      }
      if (input.input.files) {
        if (!this.options.replyAttachments) throw new Error("This LetAgents daemon cannot attach files yet.");
        // Copy the files now: the journal keeps the copies' identities, never the agent's paths.
        request = await this.options.replyAttachments.snapshot({
          workspacePath: context.entry.workspace_path,
          inboxItemId: context.inbox.inbox_item_id,
          agentId: input.entryId,
          providerTurnId: context.inbox.provider_turn_id!,
          mcpRequestId: input.mcpRequestId,
          files: input.input.files,
        });
      }
    }
    if (input.toolName === "complete_room_turn") {
      if (context.entry.provider !== "cursor") {
        throw new Error("The structured room-turn completion channel is reserved for supervised Cursor turns.");
      }
      if (!this.options.policy.structuredRoomTurnCompletion(input.input)) {
        throw new Error("The supervised room-turn completion proposal is malformed.");
      }
    }
    if (input.toolName === "join_room") {
      if (isLocalRoomApi(context.agent.apiUrl)) throw new Error("Moving a local agent to another room is not supported yet. Start an agent in the destination room.");
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
      request,
      mutation: input.mutation,
      daemon_generation: input.daemonGeneration,
    }, (commit) => this.options.authority.fenceCommit(commit));
    if (prepared.effect.state === "completed") {
      if (input.toolName === "set_reply_attachments" && prepared.created) {
        const kept = (request as { files?: Array<{ spool_id: string }> | null }).files ?? [];
        await this.options.replyAttachments?.keepOnly(context.inbox.inbox_item_id, kept.map((file) => file.spool_id)).catch(() => undefined);
      }
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
    const threadParentId = typeof args.thread_parent_id === "string" ? args.thread_parent_id.trim() : "";
    const replyTo = typeof args.reply_to === "string" ? args.reply_to.trim() : "";
    const targetMessage = threadParentId || replyTo || null;
    // An untargeted post during a bounded turn is also the activating answer.
    // Otherwise it can send once here and again as a final "answered in the room" recap.
    // Separate tool messages must explicitly target another message or thread.
    if ((input.toolName === "send_message" || input.toolName === "send_thread_message")
      && (targetMessage === null || targetMessage === context.active.sourceMessageId)) {
      return withExactRoom({
        state: "prepared",
        effect_id: prepared.effect.effect_id,
        action: "use_final_answer",
        source_message_id: context.active.sourceMessageId,
      });
    }
    const claimAuthority: BoundedEffectClaimAuthority = {
      agent_id: input.entryId,
      room_id: context.entry.room_id,
      execution_generation_id: context.providerTurnBinding.origin_execution_generation_id,
      work_attempt_id: context.agent.workAttemptId,
      current_execution_generation_id: context.agent.executionGenerationId,
      provider_continuation_id: context.agent.providerContinuationId!,
      provider_turn_id: context.inbox.provider_turn_id!,
    };
    if (!claimForExecution) {
      return withExactRoom({
        state: "prepared",
        effect_id: prepared.effect.effect_id,
        action: "execute",
        mutation: input.mutation,
        claim_authority: claimAuthority,
      });
    }
    const executing = await this.options.journal.markExecuting({
      effect_id: prepared.effect.effect_id,
      ...claimAuthority,
      daemon_generation: input.daemonGeneration,
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
      ...(input.uncertain ? { uncertain: true } : {}),
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

  private activeExecutor(): Pick<EffectExecutor, "runEffect" | "hasHandler"> | null {
    const candidate = this.options.executor?.() ?? null;
    return candidate && candidate.hasHandler(BOUNDED_MCP_EFFECT_KIND) ? candidate : null;
  }

  private unrecordedUncertainError(original: unknown): Error {
    const detail = original instanceof Error ? original.message : String(original);
    return new Error(
      `${detail} (Outcome is uncertain and could not be recorded in the effect journal; verify external state before repeating it.)`,
      { cause: original },
    );
  }

  private uncertainToolResponse(roomId: string, effectId: string, detail: unknown): Record<string, unknown> {
    return {
      state: "completed",
      room_id: roomId,
      result: this.supervisedInstruction(
        "This mutating tool may already have completed, but its result was not durably checkpointed. Verify the external state before issuing a new request; this exact request will not be repeated automatically.",
        { code: "SUPERVISED_EFFECT_OUTCOME_UNCERTAIN", effect_id: effectId, detail },
      ),
    };
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

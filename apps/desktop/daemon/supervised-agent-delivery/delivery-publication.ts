import { isLocalRoomApi } from "../../../../shared/room-api-origin.mjs";
import { sameProviderActionConnectionIdentity } from "../provider-action-port.js";
import { roomArrival } from "../queued-delivery-order.js";
import type { SupervisedInboxItem } from "../supervised-agent-inbox-store.js";
import { SupervisedAgentDeliveryCore } from "./delivery-core.js";
import { AuthorityLostError, orderedHumanSpeakingTurn, persistedAcceptedTerminal, supervisedReplyTargetForSourceMessage } from "./helpers.js";
import type { CompactionReplyTurnAuthority, SupervisedIngressAgent } from "./types.js";

/** Reply publication, no-reply and reply-turn receipts, and reply attachments. */
export abstract class SupervisedAgentDeliveryPublication extends SupervisedAgentDeliveryCore {
  /** Silence is reported only after capture and Stop arbitration settle.
   * Failed hints retain the existing publication/deadline release paths. */
  protected reportNoReply(agent: SupervisedIngressAgent, item: SupervisedInboxItem, parent: AbortController): Promise<void> {
    return this.reportReplyTurnReceipt(agent, item, parent, "no_reply");
  }

  protected reportReplyTurnReceipt(agent: SupervisedIngressAgent, item: SupervisedInboxItem, parent: AbortController,
    kind: "no_reply" | "yield" | "compaction_yield" | "settlement_yield" | "busy_yield", compaction?: CompactionReplyTurnAuthority): Promise<void> {
    const report = kind === "no_reply" ? this.http.reportNoReply : this.http.yieldReplyTurn;
    if (kind !== "no_reply" && !item.activation.turn) return Promise.resolve();
    if (!report || this.fenced || this.isStopping(agent.agentId) || parent.signal.aborted
      || isLocalRoomApi(agent.apiUrl) || item.room_id !== agent.roomId
      || !/^msg_[1-9]\d*$/.test(item.source_message_id)) return Promise.resolve();
    const native = kind === "settlement_yield" || kind === "busy_yield" ? {
      active: this.activeTurns.get(agent.agentId), handle: agent.handle,
      connection: agent.providerConnection ? { ...agent.providerConnection } : null,
      continuation: agent.providerContinuationId, origin: agent.executionGenerationId,
    } : null;
    // The pump can finish before this optional request. Give it its own
    // tracked lifetime so Stop and service handoff still cancel and join it.
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    parent.signal.addEventListener("abort", relayAbort, { once: true });
    const controllers = this.auxiliaryControllers.get(agent.agentId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.auxiliaryControllers.set(agent.agentId, controllers);
    const operation = Promise.resolve().then(async () => {
      const exactNative = () => Boolean(native?.active && native.handle && native.connection && native.continuation
        && !controller.signal.aborted && !this.fenced && !this.isStopping(agent.agentId)
        && this.activeTurns.get(agent.agentId) === native.active && native.active.phase === "responding"
        && native.active.recoveryContext === this.recoveryContext(agent) && native.active.providerTurnId
        && this.activeTurnAborts.get(agent.agentId)?.controller === parent
        && (kind === "busy_yield" ? /^msg_[1-9]\d*$/.test(native.active.sourceMessageId)
          && roomArrival(native.active.sourceMessageId) < roomArrival(item.source_message_id)
          : native.active.inboxItemId === item.inbox_item_id)
        && agent.handle === native.handle && agent.executionGenerationId === native.origin
        && agent.providerContinuationId === native.continuation
        && agent.handle.providerContinuationId === native.continuation
        && sameProviderActionConnectionIdentity(native.connection, agent.providerConnection)
        && sameProviderActionConnectionIdentity(native.connection, agent.handle.providerConnection));
      const exactCompaction = () => {
        const active = this.activeTurns.get(agent.agentId);
        return compaction && compaction.proof.isCompacting()
          && active?.invocationId === compaction.invocationId && active.phase === "responding"
          && active.recoveryContext === compaction.recoveryContext && active.inboxItemId === item.inbox_item_id
          && active.providerTurnId === compaction.proof.providerTurnId && agent.handle === compaction.handle
          && agent.providerContinuationId === compaction.proof.providerContinuationId
          && sameProviderActionConnectionIdentity(compaction.connection, agent.providerConnection)
          && sameProviderActionConnectionIdentity(compaction.connection, agent.handle.providerConnection);
      };
      const settled = kind === "busy_yield" ? await this.inbox.untouchedPending(item.inbox_item_id) : await this.inbox.get(item.inbox_item_id);
      const eligible = kind === "no_reply" ? settled?.state === "acknowledged_no_reply"
        : kind === "yield" ? settled?.state === "blocked" && !settled.provider_turn_id && !settled.outcome
        : kind === "busy_yield" ? settled && settled.agent_id === agent.agentId && settled.room_id === agent.roomId
          && orderedHumanSpeakingTurn(settled) && exactNative()
        : kind === "settlement_yield" ? exactNative()
          && settled?.provider_turn_id === native!.active!.providerTurnId
          && ["dispatching", "awaiting_result"].includes(settled.state)
          && persistedAcceptedTerminal(settled.outcome)?.kind === "no_reply"
        : exactCompaction() && settled?.provider_turn_id === compaction!.proof.providerTurnId
          && !settled.outcome && ["dispatching", "awaiting_result"].includes(settled.state);
      if (!eligible || !await this.hasLaneAuthority(agent, controller)) return;
      if (kind === "settlement_yield" || kind === "busy_yield") {
        const binding = await this.inbox.providerTurnBinding(native!.active!.inboxItemId);
        if (!binding || binding.agent_id !== agent.agentId || binding.room_id !== agent.roomId
          || binding.work_attempt_id !== agent.workAttemptId
          || binding.origin_execution_generation_id !== native!.origin
          || binding.provider_continuation_id !== native!.continuation
          || binding.provider_turn_id !== native!.active!.providerTurnId
          || !await this.hasExecutionAuthority(agent, controller) || !exactNative()) return;
        if (kind === "busy_yield") {
          const pending = await this.inbox.untouchedPending(item.inbox_item_id);
          const older = await this.inbox.get(native!.active!.inboxItemId);
          if (!pending || pending.agent_id !== agent.agentId || pending.room_id !== agent.roomId || !orderedHumanSpeakingTurn(pending)
            || !older || older.agent_id !== agent.agentId || older.room_id !== agent.roomId
            || older.provider_turn_id !== native!.active!.providerTurnId || older.outcome
            || !["dispatching", "awaiting_result"].includes(older.state) || !exactNative()) return;
        }
      }
      if (kind === "compaction_yield") {
        const binding = await this.inbox.providerTurnBinding(item.inbox_item_id);
        if (!compaction || !binding || binding.agent_id !== agent.agentId || binding.room_id !== agent.roomId
          || binding.work_attempt_id !== agent.workAttemptId
          || binding.origin_execution_generation_id !== compaction.originExecutionGenerationId
          || binding.provider_continuation_id !== compaction.proof.providerContinuationId
          || binding.provider_turn_id !== compaction.proof.providerTurnId
          || !await this.hasExecutionAuthority(agent, controller) || !exactCompaction()) return;
      }
      await report.call(this.http, { apiUrl: agent.apiUrl, roomId: agent.roomId, bearer: agent.bearer,
        sourceMessageId: item.source_message_id, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2_000)]) });
    }).finally(() => {
      parent.signal.removeEventListener("abort", relayAbort);
      controllers.delete(controller);
      if (this.auxiliaryControllers.get(agent.agentId) === controllers && controllers.size === 0) this.auxiliaryControllers.delete(agent.agentId);
    });
    return this.trackAgentWork(agent.agentId, this.track(controller, operation));
  }

  protected async publish(agent: SupervisedIngressAgent, item: SupervisedInboxItem, text: string, parent: AbortController): Promise<boolean> {
    if (!await this.hasLaneAuthority(agent, parent)) return false;
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    parent.signal.addEventListener("abort", relayAbort, { once: true });
    try {
      const replyTarget = supervisedReplyTargetForSourceMessage(item.source_message);
      if (await this.inbox.hasInterceptedThreadReply(item.inbox_item_id) && !replyTarget.threadRootId) {
        replyTarget.replyTo = item.source_message_id;
        replyTarget.threadRootId = item.source_message_id;
      }
      if (!await this.hasLaneAuthority(agent, parent)) return false;
      const gif = await this.inbox.replyGif(item.inbox_item_id);
      const attached = await this.stageReplyAttachments(agent, item, controller);
      // Uploads can take minutes; post only if this lane still owns the reply.
      if (!await this.hasLaneAuthority(agent, parent)) {
        await this.discardReplyAttachments(agent, attached.uploads);
        return false;
      }
      const publication = await this.track(controller, this.http.publish({
        roomId: agent.roomId,
        apiUrl: agent.apiUrl,
        bearer: agent.bearer,
        text: attached.unavailable.length ? `${text}\n\n(Could not attach: ${attached.unavailable.join(", ")})` : text,
        ...(gif ? { gif } : {}),
        ...(attached.uploads.length ? { attachments: attached.uploads } : {}),
        clientMessageId: item.reply_client_message_id,
        replyTo: replyTarget.replyTo,
        threadRootId: replyTarget.threadRootId,
        signal: controller.signal,
      })).catch(async (error: unknown) => {
        // The next attempt stages fresh copies, so these uploads would only wait to expire.
        await this.discardReplyAttachments(agent, attached.uploads);
        throw error;
      });
      if (!publication.messageId?.trim() || !publication.roomId?.trim() || publication.roomId !== agent.roomId) throw new Error("Room publication did not return a nonempty canonical message id in the matching room.");
      await this.replyAttachmentSpool?.remove(item.inbox_item_id).catch(() => undefined);
      this.publishedIds.set(item.inbox_item_id, publication.messageId);
      const current = await this.hasLaneAuthority(agent, parent);
      if (!current) this.publishedIds.delete(item.inbox_item_id);
      return current;
    } catch (error) { this.publishedIds.delete(item.inbox_item_id); throw error; }
    finally { parent.signal.removeEventListener("abort", relayAbort); }
  }
  /**
   * Upload the files the agent attached, just before the reply is posted:
   * a staged upload expires after 15 minutes, and a turn can run longer.
   * A file that cannot be uploaded never blocks the reply; the reply names it.
   */
  protected async stageReplyAttachments(agent: SupervisedIngressAgent, item: SupervisedInboxItem, controller: AbortController): Promise<{
    uploads: Array<{ upload_id: string }>;
    unavailable: string[];
  }> {
    const recorded = await this.inbox.replyAttachments(item.inbox_item_id);
    const uploads: Array<{ upload_id: string }> = [];
    const unavailable: string[] = [];
    const spool = this.replyAttachmentSpool;
    const stage = this.http.stageAttachment?.bind(this.http);
    for (const file of recorded) {
      if (!spool || !stage) { unavailable.push(file.name); continue; }
      const bytes = await spool.read(item.inbox_item_id, file).catch(() => null);
      if (!bytes) { unavailable.push(file.name); continue; }
      let staged: { uploadId: string } | null = null;
      // One retry covers a dropped connection or a busy server; a lasting refusal fails twice.
      for (let attempt = 0; attempt < 2 && !staged; attempt++) {
        try {
          staged = await this.track(controller, stage({
            roomId: agent.roomId, apiUrl: agent.apiUrl, bearer: agent.bearer,
            fileName: file.name, mimeType: file.mime_type, bytes, signal: controller.signal,
          }));
        } catch (error) {
          if (controller.signal.aborted) throw error;
          if (attempt === 0) await this.sleep(this.retryDelayMs);
        }
      }
      if (staged) uploads.push({ upload_id: staged.uploadId });
      else unavailable.push(file.name);
    }
    return { uploads, unavailable };
  }

  protected async discardReplyAttachments(agent: SupervisedIngressAgent, uploads: Array<{ upload_id: string }>): Promise<void> {
    if (!this.http.discardAttachment) return;
    await Promise.all(uploads.map(({ upload_id }) => this.http.discardAttachment!({
      roomId: agent.roomId, apiUrl: agent.apiUrl, bearer: agent.bearer, uploadId: upload_id, signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined)));
  }
  protected async publishedMessageId(agent: SupervisedIngressAgent, item: SupervisedInboxItem): Promise<string> {
    const id = this.publishedIds.get(item.inbox_item_id);
    if (!id) throw new Error("Room publication acknowledgement was lost before its canonical identity could be checkpointed.");
    this.publishedIds.delete(item.inbox_item_id);
    return id;
  }

  protected awaitProviderResultOrRetirement<T>(
    providerTurn: Promise<T>,
    controller: AbortController,
    waitForProviderOnRetirement: () => boolean,
    providerTurnDurable: Promise<void>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let retired = false;
      let waitsForProviderAfterRetirement = false;
      const finish = (callback: (value: T) => void, value: T) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", retire);
        callback(value);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", retire);
        reject(error);
      };
      const retire = () => {
        retired = true;
        waitsForProviderAfterRetirement = waitForProviderOnRetirement();
        if (!waitsForProviderAfterRetirement) {
          fail(new AuthorityLostError());
          return;
        }
        // The turn can cross its exact durable boundary while retirement is
        // waiting for pre-checkpoint cleanup. Detach at that moment instead of
        // retaining a now-recoverable native turn until its model result.
        void providerTurnDurable.then(() => {
          if (retired) fail(new AuthorityLostError());
        });
      };
      if (controller.signal.aborted) retire();
      else controller.signal.addEventListener("abort", retire, { once: true });
      // Before a durable native turn exists, retirement waits for the provider
      // to finish aborting and reaping its preparation helpers. After that
      // boundary, these handlers merely observe a late settlement so a user's
      // native turn can outlive this daemon without an unhandled rejection.
      void providerTurn.then(
        (result) => retired ? fail(new AuthorityLostError()) : finish(resolve, result),
        (error) => retired && !waitsForProviderAfterRetirement
          ? fail(new AuthorityLostError())
          : fail(error),
      );
    });
  }

}

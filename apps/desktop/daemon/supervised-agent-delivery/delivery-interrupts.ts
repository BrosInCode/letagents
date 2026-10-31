import { SupervisedAgentDeliveryPublication } from "./delivery-publication.js";
import type { ActiveDeliveryInterruptReservation, SupervisedDeliveryInterruptReservation, SupervisedIngressAgent } from "./types.js";

/** The active turn and exact native-Stop interrupt reservations. */
export abstract class SupervisedAgentDeliveryInterrupts extends SupervisedAgentDeliveryPublication {
  activeTurn(agent: SupervisedIngressAgent): { inboxItemId: string; sourceMessageId: string; phase: "dispatching" | "responding" | "publishing" } | null {
    const active = this.activeTurns.get(agent.agentId);
    return active?.recoveryContext === this.recoveryContext(agent)
      ? { inboxItemId: active.inboxItemId, sourceMessageId: active.sourceMessageId, phase: active.phase }
      : null;
  }

  /**
   * Capture the exact delivery owner at the provider's native interrupt edge.
   * The returned agent is the live delivery object, retaining its memory-only
   * bearer and dynamic handle getters even if provider cleanup removes the map
   * before controlTurn returns. Callers must not persist or log it.
   */
  captureActiveDeliveryInterrupt(
    agent: SupervisedIngressAgent,
    actionId: string,
  ): SupervisedDeliveryInterruptReservation | null {
    if (!actionId.trim()) throw new Error("Delivery interrupt reservation requires an exact action id.");
    const active = this.activeTurns.get(agent.agentId);
    if (active?.recoveryContext !== this.recoveryContext(agent)) return null;
    return this.installInterruptReservation({
      agent: active.agent,
      actionId,
      invocationId: active.invocationId,
      inboxItemId: active.inboxItemId,
      providerTurnId: active.providerTurnId,
      recoveryContext: active.recoveryContext,
    });
  }

  protected installInterruptReservation(input: {
    agent: SupervisedIngressAgent;
    actionId: string;
    invocationId: number;
    inboxItemId: string;
    providerTurnId: string | null;
    recoveryContext: string;
  }): SupervisedDeliveryInterruptReservation {
    const existing = this.interruptReservations.get(input.agent.agentId);
    if (existing) {
      if (existing.recoveryContext === input.recoveryContext
        && existing.reservation.invocationId === input.invocationId
        && existing.reservation.inboxItemId === input.inboxItemId
        && existing.reservation.actionId === input.actionId) {
        return existing.reservation;
      }
      throw new Error("A different turn-control action already owns this delivery interrupt boundary.");
    }
    let resolveDecision!: ActiveDeliveryInterruptReservation["resolveDecision"];
    const decision = new Promise<"cancelled" | "resume" | "freeze">((resolve) => {
      resolveDecision = resolve;
    });
    const reservation: SupervisedDeliveryInterruptReservation = {
      reservationId: this.nextInterruptReservationId++,
      invocationId: input.invocationId,
      actionId: input.actionId,
      inboxItemId: input.inboxItemId,
      providerTurnId: input.providerTurnId,
      agent: input.agent,
    };
    this.interruptReservations.set(input.agent.agentId, {
      reservation,
      recoveryContext: input.recoveryContext,
      providerTurnId: input.providerTurnId,
      decision,
      resolveDecision,
      disposition: null,
    });
    return reservation;
  }

  /** Resolve an exact native-Stop lease on every provider-control exit. */
  resolveActiveDeliveryInterrupt(
    reservation: SupervisedDeliveryInterruptReservation | null,
    disposition: "cancelled" | "resume" | "freeze",
  ): void {
    if (!reservation) return;
    const active = this.exactInterruptReservation(reservation);
    if (!active) return;
    this.resolveInterruptReservation(active, disposition);
  }

  /** Validate and converge provider runtime before the caller's atomic
   * manifest+FIFO commit. This method intentionally does not settle or wake. */
  async prepareActiveDeliveryInterrupt(
    reservation: SupervisedDeliveryInterruptReservation,
  ): Promise<"interruptible" | "publication_won" | "terminal_won"> {
    const reserved = this.exactInterruptReservation(reservation);
    if (!reserved) throw new Error("Delivery interrupt reservation is stale or belongs to a different turn.");
    const agent = reservation.agent;
    const current = await this.inbox.get(reservation.inboxItemId);
    if (!current
      || current.agent_id !== agent.agentId
      || current.room_id !== agent.roomId
      || (reserved.providerTurnId && current.provider_turn_id !== reserved.providerTurnId)) {
      throw new Error("Delivery interrupt reservation no longer owns its durable FIFO invocation.");
    }
    if (agent.provider === "cursor"
      && current.provider_turn_id
      && ["dispatching", "awaiting_result", "result_recovery"].includes(current.state)
      && agent.handle?.providerContinuationId
      && agent.handle.providerConnection
      && this.checkpointProviderState) {
      await this.checkpointProviderState({
        agent,
        inboxItemId: reservation.inboxItemId,
        providerTurnId: reserved.providerTurnId ?? current.provider_turn_id,
        providerContinuationId: agent.handle.providerContinuationId,
        providerConnection: agent.handle.providerConnection,
      });
    }
    if (await this.inbox.nativeFailure(current.inbox_item_id)) return "terminal_won";
    return ["publishing", "acknowledged", "acknowledged_no_reply"].includes(current.state)
      ? "publication_won"
      : "interruptible";
  }

  /** Release the provider-facing half only after the durable transaction won. */
  finishActiveDeliveryInterrupt(
    reservation: SupervisedDeliveryInterruptReservation | null,
    disposition: "cancelled" | "resume" | "freeze",
  ): void {
    if (!reservation) return;
    const active = this.exactInterruptReservation(reservation);
    if (!active) return;
    if (disposition === "cancelled") {
      const abort = this.activeTurnAborts.get(reservation.agent.agentId);
      if (abort?.inboxItemId === reservation.inboxItemId) abort.controller.abort();
    }
    this.resolveInterruptReservation(active, disposition);
    if (disposition !== "freeze") {
      const agent = reservation.agent.handle
        ? {
          ...reservation.agent,
          providerContinuationId: reservation.agent.handle.providerContinuationId,
          providerConnection: reservation.agent.handle.providerConnection ?? null,
        }
        : reservation.agent;
      this.wakePumpAfterSettlement(agent);
    }
  }

  finishActiveDeliveryInterruptByAction(
    agentId: string,
    actionId: string,
    disposition: "cancelled" | "resume" | "freeze",
  ): boolean {
    const active = this.interruptReservations.get(agentId);
    if (!active || active.reservation.actionId !== actionId) return false;
    this.finishActiveDeliveryInterrupt(active.reservation, disposition);
    return true;
  }

  /**
   * Stop the in-flight turn for this exact agent identity without retiring the
   * pump, so the next FIFO item (e.g. a stop-then-resend correction) can run.
   * Settles the head `cancelled_by_user` if it has not yet committed to
   * publishing, then — only on a successful settlement — aborts the turn-scoped
   * controller so `deliver()` drops its provider-result wait and returns.
   *
   * Ordering matters: the durable cancellation is committed BEFORE the abort. If
   * we aborted first and the cancellation write then failed (e.g. a transient
   * SQLite error), `deliver()` would already have exited on the turn signal,
   * leaving the head stuck `dispatching`/`awaiting_result` with no live consumer
   * to settle or retry it — a stalled FIFO. Settling first means a failed
   * cancellation leaves the in-flight `deliver()` untouched as the sole consumer.
   *
   * The three outcomes are distinct so the caller can report an honest
   * `interrupted`:
   *  - `"settled"`: the interrupt won and the item is `cancelled_by_user`.
   *  - `"published"`: there WAS an active daemon turn but it had already
   *    committed to publishing — the reply stands and the turn was not truly
   *    interrupted (only this case downgrades `interrupted`). No abort: the
   *    publishing turn keeps its own consumer.
   *  - `"no_active_turn"`: no matching daemon delivery turn (e.g. an mcp_polling
   *    agent, or an idle daemon_inbox agent). The provider's own native
   *    interrupt stands; there is no daemon reply to arbitrate.
   *
   * Without an explicit inbox reservation, the identity gate mirrors
   * `activeTurn()` so a stale caller can never abort a successor turn. The
   * reservation form is captured from that same gate at native dispatch and is
   * transactionally checked against its agent, room, and current FIFO head.
   */
  async interruptActiveDelivery(
    agent: SupervisedIngressAgent,
    inboxItemId?: string,
    reservation?: SupervisedDeliveryInterruptReservation,
  ): Promise<"settled" | "published" | "terminal_won" | "no_active_turn"> {
    const active = this.activeTurns.get(agent.agentId);
    const exactActive = active?.recoveryContext === this.recoveryContext(agent) ? active : null;
    // Cursor waits for its wrapper/reaper to settle before reporting a native
    // interrupt. That can let deliver() consume the provider rejection and
    // remove the live-map entry first. The caller therefore captures the exact
    // inbox id at markDispatched and may settle that same durable head here even
    // after its in-memory consumer has exited. Without an explicit reservation,
    // retain the historical live-map-only behavior.
    const reserved = reservation ? this.exactInterruptReservation(reservation) : null;
    if (reservation && (!reserved
      || reservation.agent !== agent
      || reservation.inboxItemId !== inboxItemId)) {
      throw new Error("Delivery interrupt reservation is stale or belongs to a different turn.");
    }
    const targetInboxItemId = reservation?.inboxItemId ?? inboxItemId ?? exactActive?.inboxItemId;
    if (!targetInboxItemId) return "no_active_turn";
    if (!inboxItemId && !exactActive) return "no_active_turn";
    const current = await this.inbox.get(targetInboxItemId);
    if (reserved?.providerTurnId
      && current?.provider_turn_id !== reserved.providerTurnId) {
      throw new Error("Delivery interrupt reservation no longer owns the admitted provider turn.");
    }
    if (agent.provider === "cursor"
      && current?.provider_turn_id
      && ["dispatching", "awaiting_result", "result_recovery"].includes(current.state)
      && agent.handle?.providerContinuationId
      && agent.handle.providerConnection
      && this.checkpointProviderState) {
      // Native Stop waits for the adapter's prepared-wrapper reaper. Before
      // cancellation can destroy the exact recovery row, idempotently converge
      // any committed live wrapper birth to the handle's now-honest idle state.
      // If this fails, cancellation must not proceed: the caller records an
      // uncertain Stop and the exact row remains available for recovery.
      await this.checkpointProviderState({
        agent,
        inboxItemId: targetInboxItemId,
        providerTurnId: reserved?.providerTurnId ?? current.provider_turn_id,
        providerContinuationId: agent.handle.providerContinuationId,
        providerConnection: agent.handle.providerConnection,
      });
    }
    // Durable cancellation first; a rejection here propagates and never detaches
    // the in-flight consumer.
    const settled = await this.inbox.cancelInterruptedTurn(targetInboxItemId, "Stopped by the user.", {
      agent_id: agent.agentId,
      room_id: agent.roomId,
    });
    if (settled?.state !== "cancelled_by_user") {
      // Publication already owns a durable normalized result. Release Stop's
      // arbitration lease so a failed HTTP publish can retry that same payload
      // and client id; this never reruns the provider turn.
      if (reserved) this.resolveInterruptReservation(reserved, "resume");
      if (settled && await this.inbox.nativeFailure(settled.inbox_item_id)) return "terminal_won";
      return "published";
    }
    const abort = this.activeTurnAborts.get(agent.agentId);
    if (abort?.inboxItemId === targetInboxItemId) abort.controller.abort();
    // Dynamic Cursor state may have moved from the now-dead wrapper PID back to
    // idle while controlTurn waited for cleanup. Retain the captured secret but
    // refresh public handle facts before authority validation and FIFO wakeup.
    const wakeAgent = agent.handle
      ? {
        ...agent,
        providerContinuationId: agent.handle.providerContinuationId,
        providerConnection: agent.handle.providerConnection ?? null,
      }
      : agent;
    if (reserved) this.resolveInterruptReservation(reserved, "cancelled");
    this.wakePumpAfterSettlement(wakeAgent);
    return "settled";
  }

  protected exactInterruptReservation(
    reservation: SupervisedDeliveryInterruptReservation,
  ): ActiveDeliveryInterruptReservation | null {
    const current = this.interruptReservations.get(reservation.agent.agentId);
    return current
      && current.reservation === reservation
      && current.reservation.reservationId === reservation.reservationId
      && current.reservation.invocationId === reservation.invocationId
      && current.reservation.actionId === reservation.actionId
      && current.reservation.inboxItemId === reservation.inboxItemId
      && current.recoveryContext === this.recoveryContext(reservation.agent)
      ? current
      : null;
  }

  protected resolveInterruptReservation(
    active: ActiveDeliveryInterruptReservation,
    disposition: "cancelled" | "resume" | "freeze",
  ): void {
    if (active.disposition) return;
    active.disposition = disposition;
    active.resolveDecision(disposition);
    const reservation = active.reservation;
    const live = this.activeTurns.get(reservation.agent.agentId);
    if (!live
      || live.invocationId !== reservation.invocationId
      || live.recoveryContext !== active.recoveryContext
      || live.inboxItemId !== reservation.inboxItemId) {
      if (this.interruptReservations.get(reservation.agent.agentId) === active) {
        this.interruptReservations.delete(reservation.agent.agentId);
      }
      if (disposition === "resume") this.wakePumpAfterSettlement(reservation.agent);
    }
  }

  protected freezeInterruptReservations(agentId?: string): void {
    for (const [candidateAgentId, reservation] of this.interruptReservations) {
      if (agentId !== undefined && candidateAgentId !== agentId) continue;
      this.resolveInterruptReservation(reservation, "freeze");
    }
  }

  protected async awaitInterruptReservationDecision(
    agent: SupervisedIngressAgent,
    inboxItemId: string,
  ): Promise<"cancelled" | "resume" | "freeze" | null> {
    const active = this.interruptReservations.get(agent.agentId);
    if (!active
      || active.reservation.invocationId !== this.activeTurns.get(agent.agentId)?.invocationId
      || active.recoveryContext !== this.recoveryContext(agent)
      || active.reservation.inboxItemId !== inboxItemId) return null;
    // Keep the resolved lease installed until deliver()'s finally block has
    // consulted it. In particular, a frozen pre-checkpoint Cursor invocation
    // must not fall through final rollback and become pending again.
    return active.decision;
  }

  protected bindInterruptReservationProviderTurn(
    agent: SupervisedIngressAgent,
    invocationId: number,
    inboxItemId: string,
    providerTurnId: string,
  ): void {
    const active = this.interruptReservations.get(agent.agentId);
    if (!active
      || active.recoveryContext !== this.recoveryContext(agent)
      || active.reservation.invocationId !== invocationId
      || active.reservation.inboxItemId !== inboxItemId) return;
    if (active.providerTurnId && active.providerTurnId !== providerTurnId) {
      throw new Error("Delivery interrupt reservation cannot be rebound to a different provider turn.");
    }
    active.providerTurnId = providerTurnId;
    (active.reservation as { providerTurnId: string | null }).providerTurnId = providerTurnId;
  }

}

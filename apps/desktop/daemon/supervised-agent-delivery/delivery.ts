import { performance } from "node:perf_hooks";
import { turnStartLatency } from "../turn-start-latency.js";
import { BEARER_ROTATION_HOLD_MS, BEARER_ROTATION_WAIT_STEP_MS, ROOM_REFUSED_ACCESS_DETAIL, SUCCESSFUL_POLL_PACE_MS, SupervisedRoomAuthorizationError } from "./constants.js";
import { SupervisedAgentDeliveryPump } from "./delivery-pump.js";
import { activatedMessages, lastMessageId, observedMessages, orderedHumanSpeakingTurn, pollErrorBackoffMs } from "./helpers.js";
import type { SupervisedIngressAgent } from "./types.js";

/**
 * The daemon-owned delivery loop. It intentionally knows no owner credential
 * and no mention grammar: a worker-authenticated poll is the sole activation
 * authority. Callers supply only an exact current binding and in-memory bearer.
 */
export class SupervisedAgentDelivery extends SupervisedAgentDeliveryPump {
  /**
   * Pause new FIFO admissions without aborting an admitted turn or its approvals. A pump that only waits for a
   * follow-up's time holds no turn: its wait ends here, so a drain does not wait for it. The follow-up keeps its
   * saved time, and whichever pump runs next waits for what is left of it.
   */
  pauseDispatch(): void {
    this.dispatchPaused = true;
    for (const wait of this.followUpWaits.values()) wait.abort();
  }

  async drainAdmittedTurns(agentIds: readonly string[]): Promise<void> {
    await Promise.allSettled(agentIds.map(id => this.pumping.get(id)));
  }

  resumeDispatch(): void {
    this.dispatchPaused = false;
    const agents = [...this.pausedDispatchAgents.values()];
    this.pausedDispatchAgents.clear();
    for (const agent of agents) this.wakePumpAfterSettlement(agent);
  }


  fence(): void {
    this.fenced = true;
    this.freezeInterruptReservations();
    for (const controller of this.controllers) controller.abort();
    this.polling.clear();
  }

  /** Fence all new authority before cancelling and joining every outstanding operation. */
  async fenceAndDrain(): Promise<void> {
    this.fence();
    // Operations are added only before their first await. A snapshot is enough
    // after the fence because no operation is permitted to create new work.
    await Promise.allSettled([...this.inFlight]);
  }

  /** One-shot callers may await delivery; continuous intake uses pollOnce directly. */
  async poll(agent: SupervisedIngressAgent): Promise<void> {
    if (!this.daemonIngressAllowed(agent)) return;
    await this.pollOnce(agent);
    await this.pumping.get(agent.agentId);
  }

  /** Starts the daemon-owned long-poll loop and normalizes persisted work first. */
  async start(
    agent: SupervisedIngressAgent,
    expectedEpoch = this.currentRefreshEpoch(agent.agentId),
    replaceMismatchedLoop = true,
  ): Promise<void> {
    for (;;) {
      if (!this.daemonIngressAllowed(agent)
        || this.fenced
        || this.isStopping(agent.agentId)
        || expectedEpoch !== this.currentRefreshEpoch(agent.agentId)) return;

      const existingLoop = this.loops.get(agent.agentId);
      if (existingLoop && this.loopEpochs.get(agent.agentId) === expectedEpoch) return;
      if (existingLoop) {
        if (!replaceMismatchedLoop) return;
        // A start that was paused before registration can install a stale loop
        // after a newer refresh already drained. Retire that mismatched epoch,
        // join it, and retry instead of leaving the newest successor asleep.
        this.polling.get(agent.agentId)?.abort();
        this.pumpControllers.get(agent.agentId)?.abort();
        this.loopControllers.get(agent.agentId)?.abort();
        await Promise.allSettled([existingLoop]);
        await Promise.resolve();
        continue;
      }

      // Every await below can admit a newer refresh. Finish the initial
      // authority check before reserving the loop slot, then register the
      // complete startup lifecycle before its health write can settle. That
      // lets stopForRefresh abort and join even a start paused in SQLite.
      if (!await this.hasIngressAuthority(agent)
        || this.fenced
        || this.isStopping(agent.agentId)
        || expectedEpoch !== this.currentRefreshEpoch(agent.agentId)) return;
      if (this.loops.has(agent.agentId)) {
        if (!replaceMismatchedLoop) return;
        continue;
      }

      const controller = new AbortController();
      let resolveStarted!: () => void;
      let rejectStarted!: (reason: unknown) => void;
      const started = new Promise<void>((resolve, reject) => {
        resolveStarted = resolve;
        rejectStarted = reject;
      });
      const lifecycle = (async () => {
        try {
          let startupFailures = 0;
          for (;;) {
            try {
              await this.inbox.setIngressHealth({ agent_id: agent.agentId, room_id: agent.roomId, execution_generation_id: agent.executionGenerationId, state: "starting" });
              break;
            } catch {
              startupFailures += 1;
              if (!await this.waitForNextPoll(controller, pollErrorBackoffMs(startupFailures))) {
                resolveStarted();
                return;
              }
            }
          }
          if (!await this.hasIngressAuthority(agent, controller)
            || this.fenced
            || this.isStopping(agent.agentId)
            || expectedEpoch !== this.currentRefreshEpoch(agent.agentId)) {
            resolveStarted();
            return;
          }
          resolveStarted();
          await this.pollLoop(agent, controller);
        } catch (error) {
          rejectStarted(error);
          throw error;
        }
      })();
      this.loopControllers.set(agent.agentId, controller);
      const operation = this.trackAgentWork(agent.agentId, this.track(controller, lifecycle));
      this.loops.set(agent.agentId, operation);
      this.loopEpochs.set(agent.agentId, expectedEpoch);
      const owner = { context: this.recoveryContext(agent), bearer: agent.bearer, agent };
      this.loopOwners.set(agent.agentId, owner);
      void operation.then(() => {
        if (this.loops.get(agent.agentId) === operation) this.loops.delete(agent.agentId);
        if (this.loopOwners.get(agent.agentId) === owner) this.loopOwners.delete(agent.agentId);
        if (this.loopEpochs.get(agent.agentId) === expectedEpoch) this.loopEpochs.delete(agent.agentId);
        if (this.loopControllers.get(agent.agentId) === controller) this.loopControllers.delete(agent.agentId);
      }, () => {
        if (this.loops.get(agent.agentId) === operation) this.loops.delete(agent.agentId);
        if (this.loopOwners.get(agent.agentId) === owner) this.loopOwners.delete(agent.agentId);
        if (this.loopEpochs.get(agent.agentId) === expectedEpoch) this.loopEpochs.delete(agent.agentId);
        if (this.loopControllers.get(agent.agentId) === controller) this.loopControllers.delete(agent.agentId);
      });
      // The lifecycle itself is tracked by fenceAndDrain(); callers wait only
      // for startup health/authority to settle, not for the worker's lifetime.
      await started;
      return;
    }
  }

  /**
   * Fill only a genuinely absent loop. This is safe to call from convergence
   * while its per-entry lock is held because it never joins, aborts, or
   * replaces an existing/stopping loop; the lifecycle owner finishes that
   * drain and a later convergence pass fills the resulting absence.
   */
  ensureStarted(agent: SupervisedIngressAgent): Promise<void> {
    if (this.loops.has(agent.agentId) || this.isStopping(agent.agentId)) {
      return Promise.resolve();
    }
    return this.start(agent, this.currentRefreshEpoch(agent.agentId), false);
  }

  /** Preserve repeated readiness for the exact owner; drain only a stale binding. */
  async refresh(agent: SupervisedIngressAgent): Promise<void> {
    const owner = this.loopOwners.get(agent.agentId);
    const exactLiveOwner = () => !this.fenced && !this.isStopping(agent.agentId)
      && this.daemonIngressAllowed(agent)
      && this.loops.has(agent.agentId)
      && this.loopEpochs.get(agent.agentId) === this.currentRefreshEpoch(agent.agentId)
      && this.loopControllers.get(agent.agentId)?.signal.aborted === false
      && this.loopOwners.get(agent.agentId) === owner
      && owner?.context === this.recoveryContext(agent);
    if (exactLiveOwner() && owner!.bearer === agent.bearer) return;
    const call = this.nextRefreshCall++;
    this.refreshCalls.set(agent.agentId, call);
    // A periodic rotation mints a new bearer for the same worker session; the
    // recovery context (generation, binding, workspace, API origin, handle) is
    // unchanged. Tearing the lane down for it would detach an in-flight turn
    // and drop the active turn its approvals and effects match against. Adopt
    // the new bearer in place once it is proven current. Any other change, or
    // a bearer the binding no longer holds, still replaces the lane below.
    if (exactLiveOwner()) {
      const epoch = this.currentRefreshEpoch(agent.agentId);
      const current = await this.hasIngressAuthority(agent);
      // A newer refresh, a stop, or a pause arrived while this one awaited;
      // that caller now decides the lane, so this stale call must not act.
      if (this.refreshCalls.get(agent.agentId) !== call
        || this.currentRefreshEpoch(agent.agentId) !== epoch) return;
      if (current && exactLiveOwner()) {
        this.adoptRotatedBearer(agent.agentId, owner!, agent.bearer);
        return;
      }
    }
    const refreshEpoch = this.nextRefreshEpoch(agent.agentId);
    await this.stopForRefresh(agent.agentId);
    // Multiple callers may share one drain. Only the most recent binding may
    // install the successor after it settles; stale refresh continuations are
    // deliberately no-ops instead of stealing the active loop slot.
    if (!this.fenced && refreshEpoch === this.currentRefreshEpoch(agent.agentId)) {
      await this.start(agent, refreshEpoch);
    }
  }

  private adoptRotatedBearer(
    agentId: string,
    owner: { bearer: string; agent: SupervisedIngressAgent; roomRefused?: boolean },
    bearer: string,
  ): void {
    owner.bearer = bearer;
    this.roomAcceptsAgain(agentId, owner);
    owner.agent.bearer = bearer;
    const pumpAgent = this.pumpAgents.get(agentId);
    if (pumpAgent) pumpAgent.bearer = bearer;
    // Interrupt reservations share the active turn's agent object.
    const active = this.activeTurns.get(agentId);
    if (active) active.agent.bearer = bearer;
    const paused = this.pausedDispatchAgents.get(agentId);
    if (paused) paused.bearer = bearer;
    // A turn that ended before this adoption could not record its result with
    // the revoked bearer and returned, leaving its row in flight with no owner.
    // Teardown used to re-run startup recovery for it; keep that, without the
    // teardown: the next pump (after any running one settles) recovers it.
    this.startupRecovered.delete(agentId);
    this.wake(owner.agent);
  }

  /** Cancel and join a removed or superseded agent without fencing other workers. */
  stop(agentId: string): Promise<void> {
    // A stop requested outside refresh invalidates any context that was merely
    // waiting on the shared drain; it must not later install a stale loop.
    this.nextRefreshEpoch(agentId);
    return this.stopForRefresh(agentId);
  }

  /**
   * Stop only an idle delivery lane. The two runtime maps deliberately cover
   * both sides of the durable-dispatch boundary: activeTurnAborts is installed
   * before native dispatch, while activeTurns owns the admitted provider turn.
   * Once stoppingAgents is set, no new pump can cross the synchronous fence.
   */
  async stopIfIdle(agentId: string): Promise<boolean> {
    const release = await this.reserveIdle(agentId);
    if (!release) return false;
    release();
    return true;
  }

  /** Keep admission closed until the lifecycle owner finishes replacing the runtime. */
  async reserveIdle(agentId: string): Promise<(() => void) | null> {
    if (this.activeTurnAborts.has(agentId)
      || this.activeTurns.has(agentId)
      || this.isStopping(agentId)
      || this.stoppingOperations.has(agentId)) return null;
    this.idleReservations.add(agentId);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.idleReservations.delete(agentId);
    };
    try {
      // Invalidate a start/refresh already paused before loop registration.
      this.nextRefreshEpoch(agentId);
      await this.startStopOperation(agentId);
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  private startStopOperation(agentId: string): Promise<void> {
    this.stoppingAgents.add(agentId);
    this.freezeInterruptReservations(agentId);
    const operation = this.stopOperation(agentId);
    this.stoppingOperations.set(agentId, operation);
    void operation.then(() => {
      if (this.stoppingOperations.get(agentId) === operation) this.stoppingOperations.delete(agentId);
      this.stoppingAgents.delete(agentId);
    }, () => {
      if (this.stoppingOperations.get(agentId) === operation) this.stoppingOperations.delete(agentId);
      this.stoppingAgents.delete(agentId);
    });
    return operation;
  }

  /** Fence old-room observation immediately while allowing the activating
   * delivery continuation to finish its durable room-move commit. */
  pauseIngress(agentId: string): void {
    this.nextRefreshEpoch(agentId);
    this.polling.get(agentId)?.abort();
    this.loopControllers.get(agentId)?.abort();
    // This is called only after the activating inbox row is terminal. Abort
    // the pump controller as well so it cannot claim a later old-room item
    // while the durable membership commit is retrying.
    this.pumpControllers.get(agentId)?.abort();
  }

  private stopForRefresh(agentId: string): Promise<void> {
    const prior = this.stoppingOperations.get(agentId);
    if (prior) return prior;
    return this.startStopOperation(agentId);
  }

  private async stopOperation(agentId: string): Promise<void> {
    this.polling.get(agentId)?.abort();
    this.pumpControllers.get(agentId)?.abort();
    this.loopControllers.get(agentId)?.abort();
    for (const controller of this.auxiliaryControllers.get(agentId) ?? []) controller.abort();
    // New work is barred before aborting. Re-check the registry until it is
    // empty so a child that was registered while its parent settled is joined.
    for (;;) {
      const work = [...(this.agentWork.get(agentId) ?? [])];
      if (work.length === 0) break;
      await Promise.allSettled(work);
      // Give identity-guarded cleanup continuations a chance to unregister
      // before deciding whether a child was attached during parent teardown.
      await Promise.resolve();
    }
    this.startupRecovered.delete(agentId);
    this.refreshCalls.delete(agentId);
    this.bearerRotations.delete(agentId);
    if (this.activeTurns.delete(agentId)) {
      try { this.observeTurn?.(agentId, { ended: null }); } catch { /* observation only */ }
    }
    this.activeTurnAborts.delete(agentId);
    const health = await this.inbox.ingressHealth(agentId);
    if (health) await this.inbox.setIngressHealth({ agent_id: agentId, room_id: health.room_id, execution_generation_id: health.execution_generation_id, state: "stopped", detail: "Ingress stopped by the supervisor." });
  }

  private async pollLoop(agent: SupervisedIngressAgent, controller: AbortController): Promise<void> {
    let consecutivePollErrors = 0;
    for (;;) {
      // Once a rotation has revoked this bearer, wait for its successor with
      // local checks only: the binding may already hold the new credential,
      // and the full authority check would end the lane about to adopt it.
      if (this.bearerHold(agent.agentId, agent.bearer)?.revoked) {
        if (!this.daemonIngressAllowed(agent) || this.isStopping(agent.agentId)
          || !await this.waitForNextPoll(controller, BEARER_ROTATION_WAIT_STEP_MS)) return;
        continue;
      }
      if (!await this.hasIngressAuthority(agent, controller)) {
        // The successor was bound before any poll was refused. Any other loss
        // of authority ends the lane as before.
        const hold = this.bearerHold(agent.agentId, agent.bearer);
        if (!hold?.successorBinding || controller.signal.aborted || this.fenced || this.isStopping(agent.agentId)
          || !this.daemonIngressAllowed(agent)) return;
        this.bearerRevoked(hold);
        continue;
      }
      const bearer = agent.bearer;
      try {
        // Intake and serialized delivery have independent lifetimes: neither
        // a long native turn nor a long network poll may block the other.
        this.schedulePump(agent);
        await this.pollOnce(agent, controller);
        consecutivePollErrors = 0;
      } catch (error) {
        // The rotation revoked this bearer: wait for its successor, with no
        // refusal, health change or backoff.
        const hold = error instanceof SupervisedRoomAuthorizationError && error.status === 401 ? this.bearerHold(agent.agentId, bearer) : null;
        if (hold) {
          this.bearerRevoked(hold);
          continue;
        }
        consecutivePollErrors += 1;
        // A refusal is shown to the owner and asks for nothing. The same
        // answer is all the daemon sees when a room admin has disconnected the
        // agent, so a refusal must never lead to a new session or a new
        // runtime. A bearer that is merely due is rotated on its schedule, by
        // the heartbeat, whether or not the room has refused it yet. Until the
        // room accepts a poll again, any failure leaves the refusal standing.
        const refused = this.roomRefusesAccess(agent.agentId);
        await this.inbox.setIngressHealth({ agent_id: agent.agentId, room_id: agent.roomId, execution_generation_id: agent.executionGenerationId,
          ...(refused ? { state: "blocked" as const, detail: ROOM_REFUSED_ACCESS_DETAIL }
            : { state: "backoff" as const, detail: error instanceof Error ? error.message : "Room observation failed." }) });
      }
      const delayMs = consecutivePollErrors
        ? pollErrorBackoffMs(consecutivePollErrors)
        : SUCCESSFUL_POLL_PACE_MS;
      if (!await this.waitForNextPoll(controller, delayMs)) return;
    }
  }

  private pollOnce(agent: SupervisedIngressAgent, parent?: AbortController): Promise<void> {
    if (this.fenced || this.isStopping(agent.agentId)) return Promise.resolve();
    const prior = this.polling.get(agent.agentId);
    if (prior) return Promise.resolve();
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    parent?.signal.addEventListener("abort", relayAbort, { once: true });
    this.polling.set(agent.agentId, controller);
    const operation = this.trackAgentWork(agent.agentId, this.track(controller, this.pollOperation(agent, controller)).finally(() => parent?.signal.removeEventListener("abort", relayAbort)));
    this.pollOperations.set(agent.agentId, operation);
    void operation.then(() => {
      if (this.pollOperations.get(agent.agentId) === operation) this.pollOperations.delete(agent.agentId);
    }, () => {
      if (this.pollOperations.get(agent.agentId) === operation) this.pollOperations.delete(agent.agentId);
    });
    return operation;
  }

  private async pollOperation(agent: SupervisedIngressAgent, controller: AbortController): Promise<void> {
    try {
      if (!await this.hasIngressAuthority(agent, controller)) return;
      let cursor = await this.inbox.cursor(agent.agentId);
      if (!cursor) {
        if (this.http.admissionOwnsInitialCursor) {
          throw new Error("Room delivery is waiting for its admission cursor; provider delivery will not poll history.");
        }
        // New identity: establish a durable boundary at the current tail.
        // The transaction only creates the cursor if one is still absent, so
        // another exact-generation recovery cannot move it backwards. A
        // message that races after this read remains after the cursor and is
        // picked up by the normal poll; history before the read is skipped.
        // Legacy in-memory test adapters predate the REST tail operation and
        // model an empty room. Real daemon ingress always supplies `latest`
        // (see productionSupervisedDeliveryHttp); it is the only production
        // path allowed to establish this boundary.
        const tail = this.http.latest
          ? await this.http.latest({ roomId: agent.roomId, apiUrl: agent.apiUrl, bearer: agent.bearer, signal: controller.signal })
          : { messages: [] as Array<Record<string, unknown>> };
        const tailId = lastMessageId(tail.messages ?? []);
        // Once this generation has observed tail N, N is the only safe first
        // boundary. Commit it even if authority changed during the read: the
        // successor must inherit N rather than re-tail later and skip the
        // messages that raced this observation.
        await this.inbox.bootstrapCursor({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: tailId });
        cursor = await this.inbox.cursor(agent.agentId);
        if (!cursor || !await this.hasIngressAuthority(agent, controller)) return;
      }
      // Freeze nonsecret observation custody before the asynchronous poll.
      // A later grant/room replacement cannot reattribute this source batch.
      let onInserted: ((sourceMessageIds: readonly string[]) => void) | undefined;
      try { onInserted = this.observeNewSources?.(agent); } catch { /* optional observation */ }
      // The lane notes whether the room refuses the bearer it holds. A
      // rotation is adopted in place while a poll is in flight, and a refusal
      // of the bearer the lane has already given up says nothing about the
      // one it holds now.
      const owner = this.loopOwners.get(agent.agentId);
      const bearer = agent.bearer;
      const response = await this.http.poll({ roomId: agent.roomId, apiUrl: agent.apiUrl, bearer, afterMessageId: cursor?.last_observed_message_id ?? null, signal: controller.signal }).catch((error: unknown) => {
        if (owner && error instanceof SupervisedRoomAuthorizationError && owner.bearer === bearer
          && (error.status !== 401 || !this.bearerHold(agent.agentId, bearer))) owner.roomRefused = true;
        throw error;
      });
      if (owner) this.roomAcceptsAgain(agent.agentId, owner);
      if (!await this.hasIngressAuthority(agent, controller)) return;
      const messages = activatedMessages(response.messages ?? []);
      const newlyInserted = new Set<string>();
      const received = await this.inbox.ingestSuccessfulPoll({
        agent_id: agent.agentId,
        room_id: agent.roomId,
        execution_generation_id: agent.executionGenerationId,
        expected_cursor: cursor?.last_observed_message_id ?? null,
        // A worker-authenticated gap page can contain only prompt rows that
        // fresh authority classifies as silent. The server omits those bodies
        // but returns the last durable id so this exact generation advances
        // without re-reading the same hidden row forever.
        last_observed_message_id:
          response.last_observed_message_id ?? lastMessageId(response.messages ?? []),
        messages,
        observed_messages: observedMessages(response.messages ?? []),
        onInserted: ids => { for (const id of ids) newlyInserted.add(id); onInserted?.(ids); },
      });
      for (const item of received) {
        if (!newlyInserted.has(item.source_message_id)) continue;
        turnStartLatency.received({ agentId: agent.agentId, item, busy: this.activeTurns.has(agent.agentId), liveHandle: Boolean(agent.handle) });
      }
      // Ingest can be deliberately slow. Do not create detached delivery work
      // after a stop/rebind changed authority while its commit was pending.
      if (!await this.hasIngressAuthority(agent, controller)) return;
      // Intake continues while an older native turn owns this local FIFO. Its
      // busy worker need not hold up available teammates on a NEW human turn.
      // Replayed sources never register another optional scheduling hint.
      for (const item of received) {
        if (!newlyInserted.has(item.source_message_id) || !orderedHumanSpeakingTurn(item)) continue;
        const active = this.activeTurns.get(agent.agentId), abort = this.activeTurnAborts.get(agent.agentId);
        if (active?.phase === "responding" && abort?.inboxItemId === active.inboxItemId) {
          void this.reportReplyTurnReceipt(agent, item, abort.controller, "busy_yield").catch(() => {});
        }
      }
      this.wakePumpAfterSettlement(agent);
    } finally {
      if (this.polling.get(agent.agentId) === controller) this.polling.delete(agent.agentId);
    }
  }


  /**
   * A refusal that was standing is over: the room accepted a poll, or the lane
   * holds a new bearer. A runtime that ended meanwhile was left as it was, so
   * ask convergence once to look again. An ordinary poll asks for nothing.
   */
  private roomAcceptsAgain(agentId: string, owner: { roomRefused?: boolean }): void {
    if (!owner.roomRefused) return;
    owner.roomRefused = false;
    this.onDeliverySettled?.(agentId);
  }

  /**
   * A same-session rotation is about to replace this lane's bearer. The server
   * revokes the old bearer when it mints the new one and ends the open poll,
   * but the lane adopts the new bearer only once it is bound. A poll in
   * between is refused, and that refusal says nothing about the room. So while
   * the hold stands, a refusal of the old bearer is not read as the room's:
   * the lane keeps polling until the old bearer is refused (or its successor
   * is bound), then waits for that successor without polling. The hold ends
   * when the lane holds another bearer, when every caller releases it,
   * `maxHoldMs` after the old bearer was first refused, or twice that after
   * the first caller took it; a refusal then shows as before.
   */
  holdIngressForBearerRotation(agentId: string, maxHoldMs = BEARER_ROTATION_HOLD_MS): () => void {
    const owner = this.loopOwners.get(agentId);
    if (!owner) return () => {};
    // A retried or second mint of the same bearer keeps the first deadline, so
    // repeated attempts cannot postpone a refusal indefinitely.
    let hold = this.bearerHold(agentId, owner.bearer);
    if (!hold) {
      hold = { bearer: owner.bearer, until: performance.now() + 2 * maxHoldMs, maxHoldMs, holders: 0, revoked: false, successorBinding: false };
      this.bearerRotations.set(agentId, hold);
    }
    hold.holders += 1;
    const held = hold;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.holders -= 1;
      if (held.holders <= 0 && this.bearerRotations.get(agentId) === held) this.bearerRotations.delete(agentId);
    };
  }

  /**
   * The rotation is about to bind the successor of this lane's bearer. From
   * then until the lane adopts it, the lane's own authority check fails; that
   * failure is the rotation, not a loss of authority.
   */
  bearerSuccessorBinding(agentId: string): void {
    const owner = this.loopOwners.get(agentId);
    const hold = owner ? this.bearerHold(agentId, owner.bearer) : null;
    if (hold) hold.successorBinding = true;
  }

  /** The announced successor bind failed: a later loss of authority is no rotation. */
  bearerSuccessorAbandoned(agentId: string): void {
    const owner = this.loopOwners.get(agentId);
    const hold = owner ? this.bearerHold(agentId, owner.bearer) : null;
    if (hold) hold.successorBinding = false;
  }

  /**
   * True while the room refuses the bearer this agent polls with (HTTP 401 or
   * 403). The daemon cannot tell why: an expired bearer and a session that a
   * room admin ended are refused with the same answer.
   */
  roomRefusesAccess(agentId: string): boolean {
    return this.loopOwners.get(agentId)?.roomRefused === true;
  }

}

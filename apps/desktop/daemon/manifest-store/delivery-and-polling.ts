/**
 * Delivery drains, agent configuration reads, live sharing, and custodial polling activation and offers.
 *
 * Where new code goes: a ManifestStore method goes in the module of its concern
 * (see the module list in store.ts); shared row helpers and types go in shared.ts.
 * A method name may be defined in only one module; store.ts throws on a duplicate.
 */
import { cancelPollingActivation, checkpointPollingActivationTurn, completePollingActivation, getPollingActivation, markPollingActivationDispatch, markPollingActivationUncertain, preparePollingActivation, unresolvedPollingActivation, type CompletePollingActivation, type DispatchPollingActivation, type PollingActivationRecord, type PreparePollingActivation, acknowledgePollingOffer, getPollingOfferTail, recordPollingOffer, type AcknowledgePollingOffer, type PollingOfferRecord, type RecordPollingOffer } from "../custodial-polling-activation.js";
import { cancelDeliveryDrain, commitDeliveryDrain, deliveryDrainReadiness, markDeliveryDrainDispatch, markDeliveryDrainUncertain, prepareCustodialForward, prepareDeliveryDrain, readDeliveryDrain, unresolvedDeliveryDrain, type DeliveryDrainReadiness, type DeliveryDrainRecord, type DispatchDeliveryDrain, type PrepareCustodialForward, type PrepareDeliveryDrain } from "../delivery-drain.js";
import type { DaemonAgentConfiguration } from "../types.js";
import { type Row, type StoredAgentConfiguration, type LiveSharingState, liveSharingState, bool, nullableString, parseJson, storeMethods } from "./shared.js";

export const deliveryAndPolling = storeMethods({
  /** Internal drain admission only. This does not switch modes or interrupt a provider. */
  async prepareDeliveryDrain(input: PrepareDeliveryDrain, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<{ created: boolean; cutover: DeliveryDrainRecord }> {
    const snapshot = structuredClone(input);
    return this.writeOperationalJournal((database) => prepareDeliveryDrain(database, snapshot,
      this.readEntryFromDatabase(database, snapshot.agentId)), commitFence);
  },

  /** Explicit pre-activation undo only; never infer general idle polling safety. */
  async prepareCustodialForward(input: PrepareCustodialForward, commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<{ created: boolean; cutover: DeliveryDrainRecord }> {
    if (typeof commitFence !== "function") throw new Error("Custodial forward requires a native ownership commit fence.");
    const snapshot = structuredClone(input);
    return this.writeOperationalJournal(database => prepareCustodialForward(database, snapshot,
      this.readEntryFromDatabase(database, snapshot.agentId)), commitFence);
  },

  async getDeliveryDrain(operationId: string): Promise<DeliveryDrainRecord | null> {
    return readDeliveryDrain(await this.getDatabase(), operationId);
  },

  async unresolvedDeliveryDrain(agentId: string): Promise<DeliveryDrainRecord | null> {
    return unresolvedDeliveryDrain(await this.getDatabase(), agentId);
  },

  async cancelDeliveryDrain(input: { operationId: string; agentId: string }, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<DeliveryDrainRecord> {
    const snapshot = { ...input };
    return this.writeOperationalJournal((database) => cancelDeliveryDrain(database, snapshot), commitFence);
  },

  async deliveryDrainReadiness(operationId: string): Promise<DeliveryDrainReadiness> {
    return this.writeOperationalJournal((database) => deliveryDrainReadiness(database, operationId));
  },

  async markDeliveryDrainDispatch(input: DispatchDeliveryDrain, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<DeliveryDrainRecord> {
    const snapshot = structuredClone(input);
    return this.writeOperationalJournal((database) => markDeliveryDrainDispatch(database, snapshot,
      this.readEntryFromDatabase(database, snapshot.agentId)), commitFence);
  },

  async markDeliveryDrainUncertain(input: { operationId: string; agentId: string }, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<DeliveryDrainRecord> {
    const snapshot = { ...input };
    return this.writeOperationalJournal((database) => markDeliveryDrainUncertain(database, snapshot), commitFence);
  },

  /** The internal caller must prove the saved native birth is gone in this fence.
   * It must invoke commit synchronously after that proof, while holding daemon ownership. */
  async commitDeliveryDrain(expectedGeneration: number, input: { operationId: string; agentId: string },
    commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<{ generation: number; cutover: DeliveryDrainRecord }> {
    if (typeof commitFence !== "function") throw new Error("Delivery drain requires a native-death commit fence.");
    const snapshot = { ...input };
    const prior = await this.getDeliveryDrain(snapshot.operationId);
    if (prior?.phase === "complete" && prior.agent_id === snapshot.agentId && prior.authority_version === 1
      && prior.strategy === "drain"
      && ((prior.from_mode === "daemon_inbox" && prior.to_mode === "mcp_polling" && prior.predecessor_operation_id === null)
        || (prior.from_mode === "mcp_polling" && prior.to_mode === "daemon_inbox" && prior.predecessor_operation_id !== null
          && prior.native_target_turn_id === null && prior.admitted_inbox_item_id === null))) {
      // A lost response may be retried after a successor is running. Return the
      // immutable receipt without another cursor transfer, stop, or revision.
      return { generation: (await this.load()).generation, cutover: prior };
    }
    const result = await this.writeTargeted(expectedGeneration, (database) => commitDeliveryDrain(database, snapshot,
      this.readEntryFromDatabase(database, snapshot.agentId)), commitFence);
    return { generation: result.generation, cutover: result.value };
  },

  async getAgentConfiguration(agentId: string): Promise<StoredAgentConfiguration | undefined> {
    const database = await this.getDatabase();
    const row = this.reads.get(database, "agentConfiguration").get(agentId) as Row | undefined;
    if (!row) return undefined;
    return { provider: String(row.provider), model: nullableString(row.model), reasoning_effort: nullableString(row.reasoning_effort) as DaemonAgentConfiguration["reasoning_effort"], charter: String(row.charter), permission_profile_id: nullableString(row.permission_profile_id), provider_launch_policy: bool(row.provider_launch_policy_present) && !bool(row.provider_launch_policy_undefined) ? parseJson(row.provider_launch_policy_json) : {}, config_revision: Number(row.config_revision), runtime_configuration_revision: Number(row.runtime_configuration_revision), polling_contract: nullableString(row.polling_contract) as DaemonAgentConfiguration["polling_contract"], delivery_mode: String(row.delivery_mode), image_input: bool(row.image_input), live_sharing: liveSharingState(row.live_sharing) };
  },

  /** Each agent's live sharing state. Agents without a configuration are left out. */
  async liveSharingByAgent(): Promise<Map<string, LiveSharingState>> {
    const database = await this.getDatabase();
    const rows = database.prepare("SELECT agent_id,live_sharing FROM agent_configurations").all() as Row[];
    return new Map(rows.map((row) => [String(row.agent_id), liveSharingState(row.live_sharing)]));
  },

  /**
   * The owner turns sharing of one agent's live activity on or off. Off
   * becomes "withdrawing" when the agent shared, so the removal of what the
   * room shows survives a restart. It is not part of the agent's launch
   * settings: the revision stays, so nothing asks for a restart. Returns the
   * saved state, or null when the agent no longer exists.
   */
  async setAgentLiveSharing(input: { agentId: string; enabled: boolean }, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<LiveSharingState | null> {
    return this.writeLiveSharing(input.agentId,
      input.enabled ? "'on'" : "CASE live_sharing WHEN 'off' THEN 'off' ELSE 'withdrawing' END", null, commitFence);
  },

  /** The room no longer shows the agent's live activity. Only a pending removal ends; a newer "on" stays. */
  async markLiveSharingWithdrawn(agentId: string, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<LiveSharingState | null> {
    return this.writeLiveSharing(agentId, "'off'", "withdrawing", commitFence);
  },

  async writeLiveSharing(agentId: string, next: string, only: LiveSharingState | null,
    commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<LiveSharingState | null> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      if (!database.prepare("SELECT 1 FROM agent_configurations WHERE agent_id=?").get(agentId)) return null;
      let committed = false;
      let transactionOpen = false;
      const commit = async () => {
        database.exec("BEGIN IMMEDIATE"); transactionOpen = true;
        database.prepare(`UPDATE agent_configurations SET live_sharing=${next} WHERE agent_id=?${only ? " AND live_sharing=?" : ""}`)
          .run(...(only ? [agentId, only] : [agentId]));
        database.exec("COMMIT"); transactionOpen = false; committed = true;
      };
      try {
        if (commitFence) await commitFence(commit); else await commit();
        if (!committed) throw new Error("Live sharing commit fence returned without committing.");
      } catch (error) {
        if (transactionOpen) { try { database.exec("ROLLBACK"); } catch {} }
        throw error;
      }
      const row = database.prepare("SELECT live_sharing FROM agent_configurations WHERE agent_id=?").get(agentId) as Row | undefined;
      return row ? liveSharingState(row.live_sharing) : null;
    });
  },

  /** Explicit operator request only; startup and credential recovery never create this journal. */
  async preparePollingActivation(input: PreparePollingActivation, commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<{ created: boolean; activation: PollingActivationRecord }> {
    this.requirePollingActivationFence(commitFence); const snapshot = structuredClone(input);
    return this.writeOperationalJournal(database => preparePollingActivation(database, snapshot,
      this.readEntryFromDatabase(database, snapshot.agentId)), commitFence);
  },

  async getPollingActivation(operationId: string): Promise<PollingActivationRecord | null> {
    return getPollingActivation(await this.getDatabase(), operationId);
  },

  async unresolvedPollingActivation(agentId: string): Promise<PollingActivationRecord | null> {
    return unresolvedPollingActivation(await this.getDatabase(), agentId);
  },

  async markPollingActivationDispatch(input: DispatchPollingActivation, commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<PollingActivationRecord> {
    this.requirePollingActivationFence(commitFence); const snapshot = structuredClone(input);
    return this.writeOperationalJournal(database => markPollingActivationDispatch(database, snapshot,
      this.readEntryFromDatabase(database, snapshot.agentId)), commitFence);
  },

  /** First IDs require the same live RPC invocation; known-ID reconciliation must remain exact. */
  async checkpointPollingActivationTurn(input: { operationId: string; agentId: string; providerTurnId: string },
    commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<PollingActivationRecord> {
    this.requirePollingActivationFence(commitFence); const snapshot = { ...input };
    return this.writeOperationalJournal(database => checkpointPollingActivationTurn(database, snapshot,
      this.readEntryFromDatabase(database, snapshot.agentId)), commitFence);
  },

  async markPollingActivationUncertain(input: { operationId: string; agentId: string }, commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<PollingActivationRecord> {
    this.requirePollingActivationFence(commitFence); const snapshot = { ...input };
    return this.writeOperationalJournal(database => markPollingActivationUncertain(database, snapshot), commitFence);
  },

  async cancelPollingActivation(input: { operationId: string; agentId: string }, commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<PollingActivationRecord> {
    this.requirePollingActivationFence(commitFence); const snapshot = { ...input };
    return this.writeOperationalJournal(database => cancelPollingActivation(database, snapshot), commitFence);
  },

  /** Fence authenticates the exact native terminal, or hard loss of the saved native birth. */
  async completePollingActivation(input: CompletePollingActivation, commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<PollingActivationRecord> {
    this.requirePollingActivationFence(commitFence); const snapshot = { ...input };
    return this.writeOperationalJournal(database => completePollingActivation(database, snapshot,
      this.readEntryFromDatabase(database, snapshot.agentId)), commitFence);
  },

  requirePollingActivationFence(fence: unknown): void {
    if (typeof fence !== "function") throw new Error("Polling activation requires a native ownership commit fence.");
  },

  async getPollingOfferTail(activationId: string): Promise<PollingOfferRecord | null> {
    return getPollingOfferTail(await this.getDatabase(), activationId);
  },

  async recordPollingOffer(input: RecordPollingOffer, commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<PollingOfferRecord | null> {
    this.requirePollingActivationFence(commitFence); const snapshot = { ...input };
    return this.writeOperationalJournal(database => recordPollingOffer(database, snapshot,
      this.readEntryFromDatabase(database, snapshot.agentId)), commitFence);
  },

  async acknowledgePollingOffer(input: AcknowledgePollingOffer, commitFence: (commit: () => Promise<void>) => Promise<void>): Promise<ReturnType<typeof acknowledgePollingOffer>> {
    this.requirePollingActivationFence(commitFence); const snapshot = { ...input };
    return this.writeOperationalJournal(database => acknowledgePollingOffer(database, snapshot,
      this.readEntryFromDatabase(database, snapshot.agentId)), commitFence);
  },
});

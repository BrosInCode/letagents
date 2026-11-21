/**
 * Agent configuration reads and live sharing.
 *
 * Where new code goes: a ManifestStore method goes in the module of its concern
 * (see the module list in store.ts); shared row helpers and types go in shared.ts.
 * A method name may be defined in only one module; store.ts throws on a duplicate.
 */
import type { DaemonAgentConfiguration } from "../types.js";
import { type Row, type StoredAgentConfiguration, type LiveSharingState, liveSharingState, bool, nullableString, parseJson, storeMethods } from "./shared.js";

export const deliveryAndPolling = storeMethods({
  async getAgentConfiguration(agentId: string): Promise<StoredAgentConfiguration | undefined> {
    const database = await this.getDatabase();
    const row = this.reads.get(database, "agentConfiguration").get(agentId) as Row | undefined;
    if (!row) return undefined;
    return { provider: String(row.provider), model: nullableString(row.model), reasoning_effort: nullableString(row.reasoning_effort) as DaemonAgentConfiguration["reasoning_effort"], charter: String(row.charter), permission_profile_id: nullableString(row.permission_profile_id), provider_launch_policy: bool(row.provider_launch_policy_present) && !bool(row.provider_launch_policy_undefined) ? parseJson(row.provider_launch_policy_json) : {}, config_revision: Number(row.config_revision), runtime_configuration_revision: Number(row.runtime_configuration_revision), delivery_mode: "daemon_inbox", image_input: bool(row.image_input), live_sharing: liveSharingState(row.live_sharing) };
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
});

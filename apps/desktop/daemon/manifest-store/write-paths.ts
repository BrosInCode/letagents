/**
 * Pre-membership room-move failure, journal and targeted write paths, serialization and file permissions.
 *
 * Where new code goes: a ManifestStore method goes in the module of its concern
 * (see the module list in store.ts); shared row helpers and types go in shared.ts.
 * A method name may be defined in only one module; store.ts throws on a duplicate.
 */
import type { DatabaseSync } from "node:sqlite";
import { chmod } from "node:fs/promises";
import { pruneSupervisedAgentHistory } from "../supervised-agent-history-retention.js";
import { type Row, type PreMembershipRoomMoveCancellation, ManifestConflictError, bool, nullableString, storeMethods } from "./shared.js";

export const writePaths = storeMethods({
  /**
   * A lifecycle stop/pause or exact runtime replacement may cancel a room move
   * only before destination join starts. The move, its MCP effect, the
   * lifecycle/runtime manifest mutation, and retention release share the
   * caller's BEGIN IMMEDIATE transaction. Later phases have possible external
   * membership effects and therefore block the lifecycle edge until ordinary
   * reconciliation reaches active/failed or compensates them.
   */
  failPreMembershipRoomMoves(
    database: DatabaseSync,
    input: PreMembershipRoomMoveCancellation,
  ): void {
    const moves = database.prepare(`SELECT * FROM agent_room_moves
      WHERE agent_id=? AND phase NOT IN ('active','failed') ORDER BY created_at`)
      .all(input.agentId) as Row[];
    if (moves.some((row) => !["prepared", "waiting_for_current_turn"].includes(String(row.phase)))) {
      throw new ManifestConflictError(
        "Agent lifecycle or runtime recovery is blocked while a room move may have changed destination membership.",
      );
    }
    if (moves.length === 0) return;
    const runtime = database.prepare(`SELECT
      m.room_id,
      d.work_attempt_id_present,
      d.work_attempt_id,
      d.provider_ref_present,
      d.provider_execution_generation_id
      FROM agent_room_memberships m
      JOIN runtime_deployments d USING(agent_id)
      WHERE m.agent_id=?`).get(input.agentId) as Row | undefined;
    if (!runtime) {
      throw new ManifestConflictError("Pre-membership room-move cancellation lost its exact agent runtime.");
    }
    const timestamp = new Date().toISOString();
    const updateMove = database.prepare(`UPDATE agent_room_moves
      SET phase='failed',error=?,updated_at=?
      WHERE operation_id=? AND agent_id=? AND phase IN ('prepared','waiting_for_current_turn')`);
    const updateEffect = database.prepare(`UPDATE supervised_agent_effects
      SET state='failed',error=?,updated_at=?
      WHERE effect_id=? AND agent_id=? AND room_id=?
        AND execution_generation_id=? AND provider_turn_id=?
        AND tool_name='join_room' AND state='prepared'`);
    for (const row of moves) {
      const sourceRoomId = String(row.source_room_id);
      const workAttemptId = nullableString(row.work_attempt_id);
      const executionGenerationId = nullableString(row.execution_generation_id);
      if (String(runtime.room_id) !== sourceRoomId
        || !bool(runtime.work_attempt_id_present)
        || nullableString(runtime.work_attempt_id) !== workAttemptId
        || !bool(runtime.provider_ref_present)
        || nullableString(runtime.provider_execution_generation_id) !== executionGenerationId
        || workAttemptId === null || executionGenerationId === null) {
        throw new ManifestConflictError("Pre-membership room move no longer matches the exact source runtime.");
      }

      const effectId = nullableString(row.effect_id);
      const activatingInboxItemId = nullableString(row.activating_inbox_item_id);
      const providerTurnId = nullableString(row.provider_turn_id);
      const mediated = effectId !== null || activatingInboxItemId !== null || providerTurnId !== null;
      if (mediated) {
        if (effectId === null || activatingInboxItemId === null || providerTurnId === null) {
          throw new ManifestConflictError("Pre-membership room move has incomplete mediated-turn authority.");
        }
        const authority = database.prepare(`SELECT
          i.agent_id AS inbox_agent_id,
          i.room_id AS inbox_room_id,
          i.provider_turn_id AS inbox_provider_turn_id,
          b.agent_id AS binding_agent_id,
          b.room_id AS binding_room_id,
          b.work_attempt_id AS binding_work_attempt_id,
          b.origin_execution_generation_id,
          b.provider_turn_id AS binding_provider_turn_id
          FROM supervised_agent_inbox i
          JOIN supervised_agent_provider_turn_bindings b USING(inbox_item_id)
          WHERE i.inbox_item_id=?`).get(activatingInboxItemId) as Row | undefined;
        if (!authority
          || String(authority.inbox_agent_id) !== input.agentId
          || String(authority.binding_agent_id) !== input.agentId
          || String(authority.inbox_room_id) !== sourceRoomId
          || String(authority.binding_room_id) !== sourceRoomId
          || nullableString(authority.inbox_provider_turn_id) !== providerTurnId
          || String(authority.binding_provider_turn_id) !== providerTurnId
          || String(authority.binding_work_attempt_id) !== workAttemptId) {
          throw new ManifestConflictError("Pre-membership room move is detached from its exact activating provider turn.");
        }
        const originExecutionGenerationId = String(authority.origin_execution_generation_id);
        const effect = database.prepare(`SELECT agent_id,room_id,execution_generation_id,provider_turn_id,tool_name,state
          FROM supervised_agent_effects WHERE effect_id=?`).get(effectId) as Row | undefined;
        if (!effect
          || String(effect.agent_id) !== input.agentId
          || String(effect.room_id) !== sourceRoomId
          || String(effect.execution_generation_id) !== originExecutionGenerationId
          || String(effect.provider_turn_id) !== providerTurnId
          || String(effect.tool_name) !== "join_room"
          || !["prepared", "failed"].includes(String(effect.state))) {
          throw new ManifestConflictError("Pre-membership room move is detached from its exact unresolved effect journal.");
        }
        if (String(effect.state) === "prepared") {
          const effectChanged = updateEffect.run(
            input.detail,
            timestamp,
            effectId,
            input.agentId,
            sourceRoomId,
            originExecutionGenerationId,
            providerTurnId,
          );
          if (Number(effectChanged.changes) !== 1) {
            throw new ManifestConflictError("Pre-membership room-move effect changed during lifecycle cancellation.");
          }
        }
      }
      const changed = updateMove.run(input.detail, timestamp, String(row.operation_id), input.agentId);
      if (Number(changed.changes) !== 1) {
        throw new ManifestConflictError("Pre-membership room-move phase changed during lifecycle cancellation.");
      }
    }
    pruneSupervisedAgentHistory(database, input.agentId, () => timestamp);
  },

  /** Journal-first transaction helper. A manifest projection must perform its
   * generation CAS inside the mutation so the projection and journal settle together. */
  writeOperationalJournal<T>(mutation: (database: DatabaseSync) => T, commitFence?: (commit: () => Promise<void>) => Promise<void>): Promise<T> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      let open = false;
      let committed = false;
      let value!: T;
      try {
        const commit = async () => {
          if (committed) throw new Error("Operational journal transaction was already committed.");
          database.exec("BEGIN IMMEDIATE");
          open = true;
          value = mutation(database);
          database.exec("COMMIT");
          open = false;
          committed = true;
        };
        if (commitFence) await commitFence(commit);
        else await commit();
        if (!committed) throw new Error("Operational journal fence returned without committing the transaction.");
        return value;
      } catch (error) {
        if (open) { try { database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ } }
        throw error;
      }
    });
  },

  writeTargeted<T>(
    expectedGeneration: number,
    mutation: (database: DatabaseSync) => T,
    commitFence?: (commit: () => Promise<void>) => Promise<void>,
  ): Promise<{ generation: number; value: T }> {
    return this.serialize(async () => {
      const database = await this.getDatabase();
      let committed = false;
      let transactionOpen = false;
      let value!: T;
      try {
        const commit = async () => {
          if (committed) throw new Error("Manifest transaction was already committed.");
          database.exec("BEGIN IMMEDIATE");
          transactionOpen = true;
          const result = database.prepare(`
            UPDATE manifest_metadata SET generation = generation + 1
            WHERE singleton = 1 AND generation = ?
          `).run(expectedGeneration);
          if (Number(result.changes) !== 1) {
            const current = Number((this.reads.get(database, "generation").get() as Row).generation);
            throw new ManifestConflictError(`Manifest generation ${current} does not match expected ${expectedGeneration}.`);
          }
          value = mutation(database);
          database.exec("COMMIT");
          transactionOpen = false;
          committed = true;
        };
        if (commitFence) await commitFence(commit);
        else await commit();
        if (!committed) throw new Error("Manifest commit fence returned without committing the transaction.");
        return { generation: expectedGeneration + 1, value };
      } catch (error) {
        if (transactionOpen) {
          try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
        }
        throw error;
      }
    });
  },

  async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writes;
    let release!: () => void;
    this.writes = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  },

  async secureDatabaseFiles(): Promise<void> {
    const paths = [this.path, `${this.path}-wal`, `${this.path}-shm`];
    if (this.permissionHousekeeping) {
      await this.permissionHousekeeping(paths);
      return;
    }
    for (const path of paths) {
      await chmod(path, 0o600).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  },
});

import { randomUUID } from "node:crypto";
import { assertNoDeliveryDrain } from "../delivery-drain.js";
import { assertNoPollingActivation } from "../custodial-polling-activation.js";
import type { SupervisedInboxItem, Row, ProviderContinuationRepair } from "./types.js";
import { run } from "./sql.js";
import { rowToItem, rowToContinuationRepair } from "./row-mapping.js";
import { InboxDeliveryStore } from "./delivery.js";

/** Durable, provider-neutral room delivery queue. It owns neither polling nor turns. */
export class SupervisedAgentInboxStore extends InboxDeliveryStore {
  async beginContinuationRepair(input: {
    agent_id: string;
    room_id: string;
    inbox_item_id: string;
    daemon_generation: number;
    execution_generation_id: string;
    work_attempt_id: string;
    expected_pid: number;
    expected_process_identity: string;
    missing_continuation: string;
  }): Promise<ProviderContinuationRepair> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      assertNoDeliveryDrain(database, input.agent_id);
      assertNoPollingActivation(database, input.agent_id);
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(input.inbox_item_id) as Row | undefined;
      if (!row) throw new Error("The blocked room message no longer exists.");
      const item = rowToItem(row);
      if (item.agent_id !== input.agent_id || item.room_id !== input.room_id
        || item.state !== "blocked" || item.failure_code !== "provider_continuation_missing"
        || item.attempt_count !== 0 || item.provider_turn_id || item.outcome) {
        throw new Error("Conversation restoration is no longer safe for this room message.");
      }
      this.assertCurrentHead(database, item);
      const active = database.prepare(`SELECT * FROM provider_continuation_repairs
        WHERE agent_id=? AND phase NOT IN ('committed','failed') LIMIT 1`).get(input.agent_id) as Row | undefined;
      if (active) {
        const repair = rowToContinuationRepair(active);
        if (repair.inbox_item_id !== input.inbox_item_id
          || repair.execution_generation_id !== input.execution_generation_id
          || repair.work_attempt_id !== input.work_attempt_id
          || repair.expected_pid !== input.expected_pid
          || repair.expected_process_identity !== input.expected_process_identity
          || repair.missing_continuation !== input.missing_continuation) {
          throw new Error("Another continuation repair owns this agent.");
        }
        if (repair.daemon_generation !== input.daemon_generation) {
          run(database.prepare("UPDATE provider_continuation_repairs SET daemon_generation=?,updated_at=? WHERE repair_id=?"),
            input.daemon_generation, this.now(), repair.repair_id);
          return rowToContinuationRepair(database.prepare("SELECT * FROM provider_continuation_repairs WHERE repair_id=?").get(repair.repair_id) as Row);
        }
        return repair;
      }
      const failed = database.prepare(`SELECT * FROM provider_continuation_repairs
        WHERE agent_id=? AND inbox_item_id=? AND phase='failed'
        ORDER BY created_at DESC LIMIT 1`).get(input.agent_id, input.inbox_item_id) as Row | undefined;
      if (failed) {
        const repair = rowToContinuationRepair(failed);
        if (repair.execution_generation_id !== input.execution_generation_id
          || repair.work_attempt_id !== input.work_attempt_id
          || repair.expected_pid !== input.expected_pid
          || repair.expected_process_identity !== input.expected_process_identity
          || repair.missing_continuation !== input.missing_continuation) {
          throw new Error("The failed continuation repair belongs to a different provider authority.");
        }
        const timestamp = this.now();
        run(database.prepare(`UPDATE provider_continuation_repairs
          SET daemon_generation=?,phase=?,attempt_count=attempt_count+1,last_error=NULL,updated_at=?
          WHERE repair_id=?`),
        input.daemon_generation, repair.replacement_continuation ? "replacement_created" : "probing", timestamp, repair.repair_id);
        run(database.prepare("UPDATE supervised_agent_inbox SET last_error=?,updated_at=? WHERE inbox_item_id=?"),
          "Restoring the saved provider conversation before any model work starts.", timestamp, input.inbox_item_id);
        this.recordEvent(database, input.inbox_item_id, `conversation_restoring:${repair.repair_id}:${repair.attempt_count + 1}`, "conversation_restoring", timestamp, "Retrying conversation restoration with the exact current provider authority.");
        return rowToContinuationRepair(database.prepare("SELECT * FROM provider_continuation_repairs WHERE repair_id=?").get(repair.repair_id) as Row);
      }
      const timestamp = this.now();
      const repairId = randomUUID();
      run(database.prepare(`INSERT INTO provider_continuation_repairs
        (repair_id,agent_id,room_id,inbox_item_id,daemon_generation,execution_generation_id,work_attempt_id,expected_pid,expected_process_identity,missing_continuation,replacement_continuation,phase,attempt_count,last_error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'probing',1,NULL,?,?)`),
      repairId, input.agent_id, input.room_id, input.inbox_item_id, input.daemon_generation,
      input.execution_generation_id, input.work_attempt_id, input.expected_pid,
      input.expected_process_identity, input.missing_continuation, timestamp, timestamp);
      run(database.prepare("UPDATE supervised_agent_inbox SET last_error=?,updated_at=? WHERE inbox_item_id=?"),
        "Restoring the saved provider conversation before any model work starts.", timestamp, input.inbox_item_id);
      this.recordEvent(database, input.inbox_item_id, `conversation_restoring:${repairId}`, "conversation_restoring", timestamp, "Verifying the saved conversation on the existing provider process.");
      return rowToContinuationRepair(database.prepare("SELECT * FROM provider_continuation_repairs WHERE repair_id=?").get(repairId) as Row);
    }));
  }

  async checkpointContinuationReplacement(repairId: string, replacementContinuation: string): Promise<ProviderContinuationRepair> {
    if (!replacementContinuation.trim()) throw new Error("Replacement continuation is required.");
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM provider_continuation_repairs WHERE repair_id=?").get(repairId) as Row | undefined;
      if (!row) throw new Error("Unknown continuation repair.");
      const repair = rowToContinuationRepair(row);
      if (repair.phase === "committed") {
        if (repair.replacement_continuation !== replacementContinuation) throw new Error("Committed continuation repair has a different replacement.");
        return repair;
      }
      if (repair.phase === "failed") throw new Error("A failed continuation repair cannot install a replacement.");
      if (repair.replacement_continuation && repair.replacement_continuation !== replacementContinuation) {
        throw new Error("Continuation repair replacement identity changed.");
      }
      run(database.prepare(`UPDATE provider_continuation_repairs
        SET replacement_continuation=?,phase='replacement_created',updated_at=? WHERE repair_id=?`),
      replacementContinuation, this.now(), repairId);
      return rowToContinuationRepair(database.prepare("SELECT * FROM provider_continuation_repairs WHERE repair_id=?").get(repairId) as Row);
    }));
  }

  async commitContinuationRepair(repairId: string, authoritativeContinuation: string, continuityReset: boolean): Promise<SupervisedInboxItem> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM provider_continuation_repairs WHERE repair_id=?").get(repairId) as Row | undefined;
      if (!row) throw new Error("Unknown continuation repair.");
      const repair = rowToContinuationRepair(row);
      if (repair.phase === "failed") throw new Error("A failed continuation repair cannot be committed.");
      if (repair.replacement_continuation) {
        if (repair.replacement_continuation !== authoritativeContinuation) {
          throw new Error("Continuation repair cannot commit a different replacement conversation.");
        }
      } else if (authoritativeContinuation !== repair.missing_continuation) {
        throw new Error("A rematerialized conversation must match the original continuation.");
      }
      const itemRow = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(repair.inbox_item_id) as Row | undefined;
      if (!itemRow) throw new Error("Continuation repair lost its room message.");
      const item = rowToItem(itemRow);
      if (item.state !== "blocked" || item.attempt_count !== 0 || item.provider_turn_id || item.outcome) {
        throw new Error("Continuation repair can no longer release this room message.");
      }
      this.assertCurrentHead(database, item);
      const timestamp = this.now();
      run(database.prepare(`UPDATE provider_continuation_repairs
        SET replacement_continuation=?,phase='committed',last_error=NULL,updated_at=? WHERE repair_id=?`),
      authoritativeContinuation, timestamp, repairId);
      run(database.prepare(`UPDATE supervised_agent_inbox
        SET state='pending',last_error=NULL,failure_code=NULL,blocked_by_inbox_item_id=NULL,next_attempt_at_ms=NULL,updated_at=?
        WHERE inbox_item_id=?`), timestamp, item.inbox_item_id);
      const detail = continuityReset
        ? "Conversation restored with a replacement thread; durable agent identity and workspace were preserved."
        : "The saved conversation became available again; no replacement was created.";
      this.recordEvent(database, item.inbox_item_id, `conversation_restored:${repairId}`, "conversation_restored", timestamp, detail);
      return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(item.inbox_item_id) as Row);
    }));
  }

  async failContinuationRepair(repairId: string, error: string): Promise<ProviderContinuationRepair> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM provider_continuation_repairs WHERE repair_id=?").get(repairId) as Row | undefined;
      if (!row) throw new Error("Unknown continuation repair.");
      const repair = rowToContinuationRepair(row);
      if (repair.phase === "committed") return repair;
      const timestamp = this.now();
      run(database.prepare("UPDATE provider_continuation_repairs SET phase='failed',last_error=?,updated_at=? WHERE repair_id=?"),
        error, timestamp, repairId);
      run(database.prepare("UPDATE supervised_agent_inbox SET last_error=?,updated_at=? WHERE inbox_item_id=? AND state='blocked'"),
        error, timestamp, repair.inbox_item_id);
      return rowToContinuationRepair(database.prepare("SELECT * FROM provider_continuation_repairs WHERE repair_id=?").get(repairId) as Row);
    }));
  }

  async exhaustCommittedContinuationRepair(
    inboxItemId: string,
    repairId: string,
    error: string,
  ): Promise<SupervisedInboxItem> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const repairRow = database.prepare(
        "SELECT * FROM provider_continuation_repairs WHERE repair_id=?",
      ).get(repairId) as Row | undefined;
      const itemRow = database.prepare(
        "SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?",
      ).get(inboxItemId) as Row | undefined;
      if (!repairRow || !itemRow) throw new Error("Conversation restoration evidence is no longer available.");
      const repair = rowToContinuationRepair(repairRow);
      const item = rowToItem(itemRow);
      if (
        repair.inbox_item_id !== item.inbox_item_id
        || repair.agent_id !== item.agent_id
        || repair.phase !== "committed"
        || item.state !== "blocked"
        || item.failure_code !== "provider_continuation_missing"
        || item.attempt_count !== 0
        || item.provider_turn_id
        || item.outcome
      ) {
        throw new Error("Conversation restoration can no longer be exhausted safely.");
      }
      this.assertCurrentHead(database, item);
      const timestamp = this.now();
      run(
        database.prepare(
          "UPDATE supervised_agent_inbox SET last_error=?,updated_at=? WHERE inbox_item_id=?",
        ),
        error,
        timestamp,
        inboxItemId,
      );
      this.recordEvent(
        database,
        inboxItemId,
        `continuation_repair_exhausted:${repairId}`,
        "blocked",
        timestamp,
        error,
      );
      return rowToItem(
        database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row,
      );
    }));
  }

  async latestContinuationRepair(agentId: string): Promise<ProviderContinuationRepair | null> {
    return this.read(async (database) => {
      const row = this.reads.get(database, "latestRepair").get(agentId) as Row | undefined;
      return row ? rowToContinuationRepair(row) : null;
    });
  }
}

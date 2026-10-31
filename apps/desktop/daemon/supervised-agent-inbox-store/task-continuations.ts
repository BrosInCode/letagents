import { DatabaseSync } from "node:sqlite";
import { FOLLOW_UP_ENDED, followUpOrigin, parseClaudeApiFailure, parseTaskContinuation, type ClaudeApiFailure, type ContinuityTask, type FollowUpKind, type TaskContinuation } from "../task-continuity.js";
import { readDurableNativeFailure } from "../supervised-agent-history-retention.js";
import type { SupervisedInboxItem, SupervisedInboxItemMetadata, Row } from "./types.js";
import { run } from "./sql.js";
import { rowToItem } from "./row-mapping.js";
import { InboxIngressStore } from "./ingress.js";

export abstract class InboxTaskContinuationStore extends InboxIngressStore {
  /** Only the unhandled tail can create work: a later message supersedes automatic continuation. */
  async taskContinuityCandidate(agentId: string): Promise<SupervisedInboxItem | null> {
    return this.read(async (database) => {
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE agent_id=? ORDER BY fifo_sequence DESC LIMIT 1").get(agentId) as Row | undefined;
      if (!row) return null;
      const item = rowToItem(row);
      if (item.state !== "acknowledged_failed" || item.activation.task_continuity_considered
        || typeof item.activation.task_continuity_owner_session_id !== "string"
        || typeof item.activation.task_continuity_failed_at !== "string"
        || readDurableNativeFailure(database, item.inbox_item_id) !== "failed") return null;
      const control = database.prepare("SELECT 1 FROM turn_control_journals WHERE agent_id=? AND turn_control_present=1 AND inbox_item_id=?").get(agentId, item.inbox_item_id);
      return control ? null : item;
    });
  }

  /**
   * Whether the provider's own result for this message's turn says it declined
   * the content. It is read from the saved result of the turn, which only the
   * adapter writes: a message's activation comes from the room and is never
   * asked, and nothing is kept that would later need clearing.
   */
  async providerRefusedTurn(inboxItemId: string): Promise<boolean> {
    return this.read(async (database) => {
      const row = database.prepare("SELECT terminal_evidence_json FROM supervised_agent_terminal_results WHERE inbox_item_id=?")
        .get(inboxItemId) as Row | undefined;
      if (!row) return false;
      try { return (JSON.parse(String(row.terminal_evidence_json)) as { refusal?: unknown } | null)?.refusal === true; }
      catch { return false; }
    });
  }

  /**
   * Whether the provider's own result for this message's turn had a shape its
   * adapter does not know. The failure text may then be the model's own words.
   * It is read from the saved result of the turn, as a refusal is.
   */
  async providerResultUnrecognized(inboxItemId: string): Promise<boolean> {
    return this.read(async (database) => {
      const row = database.prepare("SELECT terminal_evidence_json FROM supervised_agent_terminal_results WHERE inbox_item_id=?")
        .get(inboxItemId) as Row | undefined;
      if (!row) return false;
      try { return (JSON.parse(String(row.terminal_evidence_json)) as { unrecognizedResult?: unknown } | null)?.unrecognizedResult === true; }
      catch { return false; }
    });
  }

  /** Claude Code's structured account of the failed request of this message's turn, from the saved result of the turn. */
  async claudeApiFailure(inboxItemId: string): Promise<ClaudeApiFailure | null> {
    return this.read(async (database) => {
      const row = database.prepare("SELECT terminal_evidence_json FROM supervised_agent_terminal_results WHERE inbox_item_id=?")
        .get(inboxItemId) as Row | undefined;
      if (!row) return null;
      try { return parseClaudeApiFailure((JSON.parse(String(row.terminal_evidence_json)) as { claudeApiFailure?: unknown } | null)?.claudeApiFailure); }
      catch { return null; }
    });
  }

  /** The considered marker and child commit together; a restart can fill the gap after terminal settlement. */
  async enqueueTaskContinuation(input: { parentId: string; agentId: string; roomId: string; workAttemptId: string;
    providerContinuationId: string; agentSessionId: string; tasks: ContinuityTask[] | null;
    blockReason: string | null; detail: string; delayMs: number;
    /** Stop without a follow-up, keeping this reason on the failed message, so later messages are not blocked. */
    settleReason?: string | null;
    /** Guidance for the follow-up turn about why the previous one failed. */
    note?: string | null;
    /** What the follow-up is for. It is saved with the follow-up, and the owner is told from it. */
    kind?: FollowUpKind | null }): Promise<SupervisedInboxItem | null> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE agent_id=? ORDER BY fifo_sequence DESC LIMIT 1").get(input.agentId) as Row | undefined;
      if (!row || row.inbox_item_id !== input.parentId) return null;
      const parent = rowToItem(row);
      if (parent.state !== "acknowledged_failed" || parent.activation.task_continuity_considered
        || parent.room_id !== input.roomId || parent.activation.task_continuity_owner_session_id !== input.agentSessionId
        || readDurableNativeFailure(database, parent.inbox_item_id) !== "failed") return null;
      const binding = database.prepare("SELECT * FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?").get(input.parentId) as Row | undefined;
      if (binding?.work_attempt_id !== input.workAttemptId || binding.provider_continuation_id !== input.providerContinuationId) return null;
      if (database.prepare("SELECT 1 FROM turn_control_journals WHERE agent_id=? AND turn_control_present=1 AND inbox_item_id=?").get(input.agentId, input.parentId)) return null;
      const prior = this.readTaskContinuation(database, parent);
      const continuation: TaskContinuation = { parentId: parent.inbox_item_id,
        attempt: (prior?.attempt ?? 0) + 1, workAttemptId: input.workAttemptId,
        providerContinuationId: input.providerContinuationId, agentSessionId: input.agentSessionId,
        heldBefore: prior?.heldBefore ?? String(parent.activation.task_continuity_failed_at), tasks: input.tasks,
        ...(input.kind ? { kind: input.kind } : {}) };
      if (!parseTaskContinuation(continuation)) throw new Error("Invalid task continuation snapshot.");
      const childSource = `task-continuation:${parent.inbox_item_id}`;
      run(database.prepare("UPDATE supervised_agent_inbox SET activation_json=? WHERE inbox_item_id=?"),
        JSON.stringify({ ...parent.activation, task_continuity_considered: childSource }), parent.inbox_item_id);
      const setLastError = database.prepare("UPDATE supervised_agent_inbox SET last_error=?,updated_at=? WHERE inbox_item_id=?");
      // An uncertain earlier action ends the series like a settled one: no follow-up, and the reason where its owner looks.
      const uncertain = this.hasUncertainTaskEffects(database, parent);
      if (!uncertain && input.tasks?.length === 0) return null;
      const settleReason = uncertain ? FOLLOW_UP_ENDED.uncertainEffects : input.settleReason;
      if (settleReason) {
        // Also show the reason on the room message the task continued from;
        // a synthetic follow-up has no chat message of its own.
        const origin = followUpOrigin(parent, (inboxItemId) => {
          const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
          return row ? rowToItem(row) : undefined;
        });
        const timestamp = this.now();
        for (const id of new Set([parent.inbox_item_id, origin.inbox_item_id])) run(setLastError, settleReason, timestamp, id);
        return null;
      }
      // No model turn is replayed. The same native conversation retains its files and tool history.
      const source = parent.source_message && typeof parent.source_message === "object" ? parent.source_message as Record<string, unknown> : {};
      const child = this.insertSyntheticMessage(database, { agent_id: input.agentId, room_id: input.roomId,
        source_message_id: childSource, activation: { task_continuity: continuation },
        source_message: { ...source, sender: "letagents", source: "system", text: [
          "Continue the unfinished task after a provider failure. This is a new continuation of existing authorized work, not a replay of the original request.",
          ...(input.note ? [input.note] : []),
          `Tasks and exact work leases: ${JSON.stringify(input.tasks)}`,
          "Preserve existing work. Inspect the current files, Git status, task board, and your prior tool results before proceeding. Do not repeat completed actions, claims, commits, PRs, or merges. Verify any uncertain external action before attempting it again; report a blocker if its result cannot be established.",
          "Continue only these tasks while you still hold their work leases. Keep the existing scope and approval requirements. If they are already finished or no longer yours, take no action.",
        ].join("\n") } });
      const reason = input.blockReason;
      const timestamp = this.now();
      run(database.prepare("UPDATE supervised_agent_inbox SET state=?,last_error=?,next_attempt_at_ms=? WHERE inbox_item_id=?"),
        reason ? "blocked" : "pending", reason ?? input.detail, reason ? null : Date.parse(timestamp) + input.delayMs, child.inbox_item_id);
      this.recordEvent(database, child.inbox_item_id, "task-continuation:0", reason ? "blocked" : "retry_scheduled", timestamp, reason ?? input.detail);
      return rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(child.inbox_item_id) as Row);
    }));
  }

  protected readTaskContinuation(database: DatabaseSync, item: SupervisedInboxItem): TaskContinuation | null {
    if (!item.source_message_id.startsWith("task-continuation:")) return null;
    const metadata = parseTaskContinuation(item.activation.task_continuity);
    if (!metadata || item.source_message_id !== `task-continuation:${metadata.parentId}`) throw new Error("Task continuation metadata is invalid.");
    const parent = database.prepare(`SELECT i.*,b.work_attempt_id,b.provider_continuation_id FROM supervised_agent_inbox i
      JOIN supervised_agent_provider_turn_bindings b ON b.inbox_item_id=i.inbox_item_id WHERE i.inbox_item_id=?`).get(metadata.parentId) as Row | undefined;
    const activation = parent ? rowToItem(parent).activation : null;
    if (!parent || parent.agent_id !== item.agent_id || parent.room_id !== item.room_id
      || parent.work_attempt_id !== metadata.workAttemptId || parent.provider_continuation_id !== metadata.providerContinuationId
      || activation?.task_continuity_considered !== item.source_message_id
      || activation.task_continuity_owner_session_id !== metadata.agentSessionId
      || readDurableNativeFailure(database, metadata.parentId) !== "failed") throw new Error("Task continuation lost its original owner or failure evidence.");
    return metadata;
  }

  async taskContinuation(inboxItemId: string): Promise<TaskContinuation | null> {
    return this.read(async (database) => {
      const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
      return row ? this.readTaskContinuation(database, rowToItem(row)) : null;
    });
  }

  protected hasUncertainTaskEffects(database: DatabaseSync, parent: Pick<SupervisedInboxItemMetadata, "inbox_item_id" | "agent_id" | "room_id" | "provider_turn_id">): boolean {
    const binding = database.prepare("SELECT origin_execution_generation_id FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?").get(parent.inbox_item_id) as Row | undefined;
    // A turn that is kept without its binding cannot be matched to its actions. It is taken as uncertain: no follow-up is made for it, and
    // a note about it stays. A projection must never throw for it.
    if (!binding) return true;
    return ["supervised_agent_effects", "supervised_agent_effect_tombstones"].some((table) => Boolean(database.prepare(`SELECT 1 FROM ${table}
      WHERE agent_id=? AND room_id=? AND execution_generation_id=? AND provider_turn_id=? AND mutation=1 AND state IN ('executing','uncertain') LIMIT 1`)
      .get(parent.agent_id, parent.room_id, binding.origin_execution_generation_id as string, parent.provider_turn_id)));
  }

  async taskContinuationHasUncertainEffects(inboxItemId: string): Promise<boolean> {
    return this.read(async (database) => {
      const item = rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row);
      const continuation = this.readTaskContinuation(database, item);
      if (!continuation) return false;
      return this.hasUncertainTaskEffects(database, rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(continuation.parentId) as Row));
    });
  }

  async taskContinuationDelay(inboxItemId: string): Promise<number> {
    const item = await this.get(inboxItemId);
    return Math.max(0, (item?.next_attempt_at_ms ?? 0) - Date.parse(this.now()));
  }

  /** Resolve a previously unavailable snapshot, or remove tasks that have since finished. Never add to a known scope. */
  async refreshTaskContinuationSnapshot(inboxItemId: string, tasks: ContinuityTask[]): Promise<TaskContinuation> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const item = rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row);
      const previous = this.readTaskContinuation(database, item);
      if (!previous || item.state !== "pending" || item.provider_turn_id || item.outcome || !tasks.length
        || (previous.tasks && tasks.some((task) => !previous.tasks!.some((old) => old.id === task.id && old.leaseId === task.leaseId && old.epoch === task.epoch)))) throw new Error("Task continuation scope cannot expand.");
      this.assertCurrentHead(database, item);
      const metadata = { ...previous, tasks };
      if (!parseTaskContinuation(metadata)) throw new Error("Invalid task continuation snapshot.");
      const source = item.source_message as Record<string, unknown>;
      const text = String(source.text).replace(/^Tasks and exact work leases:.*$/m, `Tasks and exact work leases: ${JSON.stringify(tasks)}`);
      run(database.prepare("UPDATE supervised_agent_inbox SET activation_json=?,source_message_json=? WHERE inbox_item_id=?"),
        JSON.stringify({ ...item.activation, task_continuity: metadata }), JSON.stringify({ ...source, text }), inboxItemId);
      return metadata;
    }));
  }

  /** A follow-up that waits for its time, and that nothing has started: the only kind its owner can start now or stop. */
  private scheduledTaskContinuation(database: DatabaseSync, inboxItemId: string): SupervisedInboxItem {
    const row = database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row | undefined;
    const item = row ? rowToItem(row) : null;
    if (!item || !this.readTaskContinuation(database, item) || item.state !== "pending" || item.provider_turn_id || item.outcome) {
      throw new Error("This automatic attempt has already started or ended.");
    }
    this.assertCurrentHead(database, item);
    return item;
  }

  /** Try now: the follow-up's time is now. It stays the same follow-up, so it is the same attempt. */
  async startTaskContinuationNow(inboxItemId: string): Promise<void> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      this.scheduledTaskContinuation(database, inboxItemId);
      const timestamp = this.now();
      run(database.prepare("UPDATE supervised_agent_inbox SET next_attempt_at_ms=?,updated_at=? WHERE inbox_item_id=?"), Date.parse(timestamp), timestamp, inboxItemId);
      this.recordEvent(database, inboxItemId, `task-continuation:now:${timestamp}`, "retry_scheduled", timestamp, "Started now, as its owner asked.");
    }));
  }

  /** Stop trying: the follow-up ends before anything started, and no other is made for it. Later messages go ahead. */
  async stopTaskContinuation(inboxItemId: string, detail: string): Promise<void> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const item = this.scheduledTaskContinuation(database, inboxItemId);
      const timestamp = this.now();
      run(database.prepare(`UPDATE supervised_agent_inbox SET state='cancelled_by_user',last_error=?,next_attempt_at_ms=NULL,acknowledged_at=?,updated_at=?
        WHERE inbox_item_id=?`), detail, timestamp, timestamp, inboxItemId);
      this.settleTerminalItem(database, item, timestamp);
      this.recordEvent(database, inboxItemId, "user_cancelled", "user_cancelled", timestamp, detail);
      this.pruneAgentHistory(database, item.agent_id);
    }));
  }

  /** A never-dispatched synthetic continuation can become unnecessary; it has no native outcome to overwrite. */
  async finishUnusedTaskContinuation(inboxItemId: string, detail: string): Promise<void> {
    return this.exclusive(async (database) => this.transaction(database, () => {
      const item = rowToItem(database.prepare("SELECT * FROM supervised_agent_inbox WHERE inbox_item_id=?").get(inboxItemId) as Row);
      if (!this.readTaskContinuation(database, item) || item.state !== "pending" || item.provider_turn_id || item.outcome) throw new Error("Only an undispatched task continuation can be skipped.");
      this.assertCurrentHead(database, item);
      const timestamp = this.now();
      run(database.prepare("UPDATE supervised_agent_inbox SET state='acknowledged_no_reply',last_error=?,acknowledged_at=?,updated_at=? WHERE inbox_item_id=?"), detail, timestamp, timestamp, inboxItemId);
      this.recordEvent(database, inboxItemId, "task-continuation:unused", "no_reply", timestamp, detail);
      this.settleTerminalItem(database, item, timestamp);
      this.pruneAgentHistory(database, item.agent_id);
    }));
  }
}

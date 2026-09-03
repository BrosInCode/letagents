import type { DatabaseSync } from "node:sqlite";
import { publishRoomWork, type RoomWorkPublishInput, type RoomWorkPublishResult } from "./cloud-http.js";
import { openDaemonStateObservationDatabase } from "./daemon-state-database.js";
import { ExecutionShadowStore } from "./execution-shadow-store.js";
import { RoomWorkPublicationStore, type RoomWorkOrigin, type RoomWorkPublication } from "./room-work-publication-store.js";
import type { SupervisedIngressAgent } from "./supervised-agent-delivery.js";
import type { WorkerRuntimeCustody } from "./worker-runtime-custody.js";
import { currentWorkerPublicationAuthority, sameWorkerPublicationOrigin } from "./worker-publication-authority.js";

type Options = {
  custody: Pick<WorkerRuntimeCustody, "hostGrant" | "workerAuthorization">;
  daemonGeneration(): number;
  isClosing(): boolean;
  assertCurrent(): Promise<void>;
  publish?(input: RoomWorkPublishInput): Promise<RoomWorkPublishResult>;
  diagnostic?(code: "storage_unavailable" | "authority_unavailable" | "publication_unavailable" | "publication_conflict"): void;
  now?(): number;
};
type Row = Record<string, string | number | null>;
const COALESCE_MS = 1_000;
const RETRY_MS = 30_000;
const canonicalSource = (id: string) => /^msg_[1-9]\d{0,9}$/.test(id) && Number(id.slice(4)) <= 2147483647;
const key = (record: Pick<RoomWorkPublication, "agentId" | "roomId" | "sourceMessageId">) =>
  JSON.stringify([record.agentId, record.roomId, record.sourceMessageId]);

/** Optional, bounded evidence upload. Owns no provider, delivery or credential-recovery port. */
export class RoomWorkPublisher {
  private readonly store: RoomWorkPublicationStore;
  private readonly capture: ExecutionShadowStore;
  private readonly stamps = new Map<string, Map<string, string>>();
  private readonly attemptedAt = new Map<string, number>();
  private readonly stagingAttemptedAt = new Map<string, number>();
  private readonly cancellation = new AbortController();
  private scheduled: NodeJS.Timeout | null = null;
  private scheduledFor = Infinity;
  private running = false;
  private pendingWake = false;
  private closed = false;
  private scanAfter = "";

  static open(path: string, options: Options): RoomWorkPublisher | null {
    try {
      const publisher = new RoomWorkPublisher(openDaemonStateObservationDatabase(path), options);
      publisher.schedule(0);
      return publisher;
    } catch { console.warn("[room_work_publication] storage_unavailable"); return null; }
  }

  constructor(private readonly database: DatabaseSync, private readonly options: Options) {
    this.store = new RoomWorkPublicationStore(database);
    this.capture = new ExecutionShadowStore(database);
  }

  /** Called before the worker-authenticated poll, never after delayed native capture. */
  observeNewSources(agent: SupervisedIngressAgent): ((ids: readonly string[]) => void) | undefined {
    const authority = this.authority(agent.agentId);
    if (!authority || agent.deliveryMode !== "daemon_inbox" || agent.daemonGeneration !== this.options.daemonGeneration()
      || authority.origin.roomId !== agent.roomId || authority.origin.apiOrigin !== agent.apiUrl
      || authority.worker.agentSessionId !== agent.agentSessionId || authority.worker.bearer !== agent.bearer
      || authority.worker.workAttemptId !== agent.workAttemptId) return;
    const origin = { ...authority.origin };
    const generation = agent.daemonGeneration;
    return ids => {
      if (this.unavailable() || generation !== this.options.daemonGeneration()) return;
      const current = this.authority(origin.agentId);
      if (!current || !this.sameOrigin(current.origin, origin, true)) return;
      // A missed pin stays local. Replayed inbox rows never call this hook.
      try { this.store.pin(origin, ids.filter(canonicalSource)); this.changed(origin.agentId); }
      catch { this.report("storage_unavailable"); }
    };
  }

  /** Capture supplies only a postcommit hint; no SQL or HTTP runs on its stack. */
  changed(_agentId: string): void {
    if (this.unavailable()) return;
    this.pendingWake = true;
    this.schedule(COALESCE_MS);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancellation.abort();
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    this.scheduledFor = Infinity;
    this.stamps.clear(); this.attemptedAt.clear(); this.stagingAttemptedAt.clear();
    // Never drain capture or upload a shutdown tail. Late responses are fenced.
    try { this.database.close(); } catch { this.report("storage_unavailable"); }
  }

  private unavailable(): boolean { return this.closed || this.options.isClosing(); }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private report(code: Parameters<NonNullable<Options["diagnostic"]>>[0]): void {
    try { if (this.options.diagnostic) this.options.diagnostic(code); else console.warn(`[room_work_publication] ${code}`); } catch { /* optional diagnostics */ }
  }
  private schedule(delay: number): void {
    if (this.unavailable()) return;
    const due = Date.now() + delay;
    if (this.scheduled && this.scheduledFor <= due) return;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduledFor = due;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      this.scheduledFor = Infinity;
      void this.flush();
    }, delay);
    this.scheduled.unref();
  }

  private authority(agentId: string) {
    return this.unavailable() ? null : currentWorkerPublicationAuthority(
      this.options.custody,
      agentId,
      this.options.daemonGeneration(),
      this.now(),
    );
  }

  private sameOrigin(left: RoomWorkOrigin, right: RoomWorkOrigin, requireOriginalSession = false): boolean {
    return sameWorkerPublicationOrigin(left, right, requireOriginalSession);
  }

  /** Cheap, bounded change stamps avoid replaying every historical message on every output chunk. */
  private async stageChanged(agentId: string): Promise<boolean> {
    const records = this.store.list(agentId).filter(record => record.state === "open");
    if (!records.length) { this.stamps.delete(agentId); return false; }
    const facts = this.database.prepare(`SELECT f.sequence,f.runtime_generation_id,f.domain,t.attempt_id
      FROM (SELECT * FROM execution_facts WHERE agent_id=? ORDER BY sequence LIMIT 10001) f
      LEFT JOIN execution_turns t ON t.turn_id=f.turn_id AND t.agent_id=f.agent_id
        AND t.execution_generation_id=f.execution_generation_id AND t.runtime_generation_id=f.runtime_generation_id`).all(agentId) as Row[];
    if (facts.length > 10_000) throw new Error("Capture retention budget exceeded.");
    const attempts = new Map<string, { sequence: number; runtimes: Set<string> }>();
    const runtimeSequence = new Map<string, number>();
    for (const fact of facts) {
      const runtime = String(fact.runtime_generation_id);
      if (fact.domain === "turn" || fact.domain === "execution") {
        if (!fact.attempt_id) continue;
        const value = attempts.get(String(fact.attempt_id)) ?? { sequence: 0, runtimes: new Set<string>() };
        value.sequence = Math.max(value.sequence, Number(fact.sequence)); value.runtimes.add(runtime);
        attempts.set(String(fact.attempt_id), value);
      } else runtimeSequence.set(runtime, Math.max(runtimeSequence.get(runtime) ?? 0, Number(fact.sequence)));
    }
    const observer = this.database.prepare("SELECT source_id,last_source_sequence,max_observed_sequence FROM execution_observers WHERE agent_id=?").get(agentId);
    const incomplete = !observer || observer.source_id === null || Number(observer.max_observed_sequence) > Number(observer.last_source_sequence);
    const previous = this.stamps.get(agentId) ?? new Map<string, string>();
    this.stamps.set(agentId, previous);
    const candidates: Array<{ record: RoomWorkPublication; stamp: string }> = [];
    let scanned = 0;
    for (const record of records) {
      if (++scanned % 64 === 0) {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (this.unavailable()) return false;
      }
      const attempt = this.database.prepare("SELECT attempt_id,state,conclusion FROM execution_message_attempts WHERE agent_id=? AND room_id=? AND source_message_id=?")
        .get(record.agentId, record.roomId, record.sourceMessageId);
      if (!attempt) continue;
      const evidence = attempts.get(String(attempt.attempt_id));
      if (!evidence) continue;
      const sequence = Math.max(evidence.sequence, ...[...evidence.runtimes].map(runtime => runtimeSequence.get(runtime) ?? 0));
      const stamp = JSON.stringify([attempt.attempt_id, attempt.state, attempt.conclusion, sequence, incomplete]);
      const recordKey = key(record);
      if (previous.get(recordKey) !== stamp) candidates.push({ record, stamp });
    }
    const eligible = candidates.filter(({ record }) => {
      const prior = this.stagingAttemptedAt.get(key(record));
      return prior === undefined || this.now() - prior >= RETRY_MS;
    }).sort((a, b) => (this.stagingAttemptedAt.get(key(a.record)) ?? -Infinity)
      - (this.stagingAttemptedAt.get(key(b.record)) ?? -Infinity));
    for (const { record, stamp } of eligible.slice(0, 4)) {
      await new Promise<void>(resolve => setImmediate(resolve));
      await this.options.assertCurrent();
      if (this.unavailable()) return false;
      const recordKey = key(record);
      this.stagingAttemptedAt.set(recordKey, this.now());
      try {
        const captured = this.capture.roomWorkSummary(record.agentId, record.roomId, record.sourceMessageId);
        if (captured.availability !== "available") continue;
        this.store.stage(record, captured);
        previous.set(recordKey, stamp);
        this.stagingAttemptedAt.delete(recordKey);
      } catch { this.report("storage_unavailable"); }
    }
    return eligible.length > 4;
  }

  /** Separable from the timer for deterministic real-store tests. No caller awaits this to run an agent. */
  async flush(): Promise<void> {
    if (this.unavailable() || this.running) return;
    this.pendingWake = false;
    this.running = true;
    let more = false;
    try {
      await this.options.assertCurrent();
      if (this.unavailable()) return;
      // One agent (at most 10k pins/facts) per pass. Cursor-based sweeping also
      // repairs missed/failed staging hints and catches up after restart, without
      // ever materializing all historical agents' pending bodies at once.
      const nextAgent = () => this.database.prepare(`SELECT agent_id FROM room_work_publications
        WHERE state='open' AND agent_id>? ORDER BY agent_id LIMIT 1`).get(this.scanAfter);
      let row = nextAgent();
      if (!row) { this.scanAfter = ""; row = nextAgent(); }
      if (!row) return;
      const agentId = String(row.agent_id);
      this.scanAfter = agentId;
      more = !!nextAgent();
      try { more = await this.stageChanged(agentId) || more; }
      catch { this.report("storage_unavailable"); }
      if (this.unavailable()) return;
      const pending = this.store.list(agentId)
        .filter(record => record.state === "open" && record.summary && record.revision > record.acknowledgedRevision)
        .sort((a, b) => (this.attemptedAt.get(key(a)) ?? -Infinity) - (this.attemptedAt.get(key(b)) ?? -Infinity));
      const eligible: Array<{ record: RoomWorkPublication; authority: NonNullable<ReturnType<RoomWorkPublisher["authority"]>> }> = [];
      for (const record of pending) {
        const prior = this.attemptedAt.get(key(record));
        if (prior !== undefined && this.now() - prior < RETRY_MS) continue;
        const authority = this.authority(record.agentId);
        if (authority && this.sameOrigin(authority.origin, record)) eligible.push({ record, authority });
      }
      more = eligible.length > 4 || more;
      for (const { record, authority } of eligible.slice(0, 4)) {
        await this.options.assertCurrent();
        const current = this.authority(record.agentId);
        if (this.unavailable() || current?.grant !== authority.grant || current?.worker !== authority.worker) continue;
        this.attemptedAt.set(key(record), this.now());
        try {
          const result = await (this.options.publish ?? publishRoomWork)({ apiOrigin: record.apiOrigin,
            grantId: authority.grant.grantId, supervisorGrant: authority.grant.supervisorGrant,
            grantGeneration: authority.grant.grantGeneration, sessionId: authority.worker.agentSessionId,
            roomId: record.roomId, sourceMessageId: record.sourceMessageId, agentKey: record.agentKey,
            revision: record.revision, summary: record.summary!, signal: this.cancellation.signal });
          await this.options.assertCurrent();
          if (this.unavailable()) return;
          if (result === "acknowledged") {
            this.store.acknowledge(record);
            this.attemptedAt.delete(key(record));
          }
          else {
            this.store.stop(record, result);
            if (result === "conflict") this.report("publication_conflict");
          }
        } catch { if (!this.unavailable()) this.report("publication_unavailable"); }
      }
    } catch { if (!this.unavailable()) this.report("authority_unavailable"); }
    finally {
      this.running = false;
      this.schedule(more || this.pendingWake ? COALESCE_MS : RETRY_MS);
    }
  }
}

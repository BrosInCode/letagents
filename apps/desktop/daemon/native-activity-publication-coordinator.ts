import { isLocalRoomApi } from "../../../shared/room-api-origin.mjs";
import { NativeActivityRejectedError, publishWorkerNativeActivity } from "./cloud-http.js";
import { redactCredentialText } from "./credential-redaction.js";
import { LiveActivitySummaryRelay, type LiveActivitySummaryRelayOptions, type LiveActivitySummaryStatus } from "./live-activity-summary-relay.js";
import { awaitsCredentialHandoff, resolveReadyReachedAt } from "./provider-stream-policy.js";
import type { DaemonManifestEntry } from "./types.js";
import type { WorkerBindingStore, WorkerSessionBinding } from "./worker-binding-store.js";

export type NativeActivityPublicationPorts = {
  bindings: Pick<WorkerBindingStore, "credentialFor" | "get" | "publish">;
  updateEntry(
    entryId: string,
    update: (entry: DaemonManifestEntry) => DaemonManifestEntry,
    options?: { readsNoActivity?: boolean },
  ): Promise<DaemonManifestEntry>;
  startDelivery(entryId: string): Promise<void>;
  /** The request to the room server; a test supplies its own. */
  publishWorkerActivity?: typeof publishWorkerNativeActivity;
};

export type NativeActivityPublicationOptions = Omit<LiveActivitySummaryRelayOptions, "publish"> & {
  /** The interval of the heartbeat that calls publishIfDue. It sets when a known status is sent again. */
  heartbeatIntervalMs?: number;
};

type NativeActivityStatus = "working" | "idle";

/**
 * After how many heartbeats a status that the room already has is sent
 * again. A publication writes the agent's presence row: its status, its
 * activity line and the time of its heartbeat. It does not decide whether
 * the room shows the agent as online: the server takes that from the
 * delivery lease of the agent's open poll.
 *
 * A working agent: every heartbeat (15 seconds), as it always was. Other
 * writers change the same row. Each room tool call of the agent's own MCP
 * process writes the status that process remembers, idle by default, and the
 * daemon's next publication puts "working" back: until then the room shows
 * a working agent as idle. The server also keeps the "working" mark of the
 * row for only 90 seconds after its heartbeat (the account activity reader).
 *
 * An idle agent: every third heartbeat (45 seconds). The heartbeat of an
 * idle row is only shown as a last-seen time. What another writer set on the
 * row (an agent's own post_status) stays that much longer. The daemon's own
 * view of the agent's workplace reads the time of the last publication with
 * a window of 90 seconds at least, so an idle agent must stay well inside it.
 */
export const NATIVE_ACTIVITY_REFRESH_HEARTBEATS: Readonly<Record<NativeActivityStatus, number>> = { working: 1, idle: 3 };

/**
 * The age at which a status the room has is due again: half a heartbeat
 * less than its refresh. The heartbeat that is due then counts also when
 * its timer fires a little early. A status that went out between two
 * heartbeats (from a provider event, or with a new activity line) is sent
 * again half a heartbeat later than that at most: after 22.5 seconds for a
 * working agent and 52.5 seconds for an idle one.
 */
export function nativeActivityRefreshAfterMs(heartbeatIntervalMs: number, status: NativeActivityStatus): number {
  return (NATIVE_ACTIVITY_REFRESH_HEARTBEATS[status] - 0.5) * heartbeatIntervalMs;
}

type BindingIdentity = Pick<WorkerSessionBinding, "room_id" | "agent_session_id" | "execution_generation_id">;

/** The newest publication of an entry that the room server accepted. */
type AcceptedActivity = BindingIdentity & {
  sequence: number;
  status: NativeActivityStatus;
  activitySummary: string | null;
  sentAtMs: number;
};

function sameBinding(left: BindingIdentity, right: BindingIdentity): boolean {
  return left.room_id === right.room_id
    && left.agent_session_id === right.agent_session_id
    && left.execution_generation_id === right.execution_generation_id;
}

/**
 * Owns the durable publication reservation and remote native-liveness effect.
 * Credential custody remains in WorkerBindingStore and manifest recovery is
 * committed only after the exact binding publication succeeds.
 */
export class NativeActivityPublicationCoordinator {
  private readonly summaries: LiveActivitySummaryRelay;
  private readonly accepted = new Map<string, AcceptedActivity>();
  /** How many publications of each status are on their way to the room server. */
  private readonly inFlight = new Map<string, Record<NativeActivityStatus, number>>();
  private readonly nowMs: () => number;
  private readonly heartbeatIntervalMs: number;

  constructor(
    private readonly ports: NativeActivityPublicationPorts,
    options: NativeActivityPublicationOptions = {},
  ) {
    const { heartbeatIntervalMs = 15_000, ...summaryClock } = options;
    this.nowMs = summaryClock.nowMs ?? Date.now;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.summaries = new LiveActivitySummaryRelay({
      ...summaryClock,
      publish: (entryId, status) => this.publish(entryId, "native_harness.activity_summary", status),
    });
  }

  /**
   * Record what the agent does now, in the words its owner sees. The room
   * receives a change within the summary interval, and every later working
   * publication carries it. Null clears it when the turn ends.
   */
  observeActivitySummary(entryId: string, summary: string | null, status: LiveActivitySummaryStatus): void {
    this.summaries.observe(entryId, summary, status);
  }

  /**
   * Publish liveness that no caller waits on an answer for: the heartbeat
   * and the provider events. It is sent when it tells the room something new
   * (a binding the room has not heard from, another status, another activity
   * line), when the room's copy is due for a refresh, or while a publication
   * with the other status is on its way. Anything else the room already
   * has: it is dropped here, with no sequence reserved and no request made,
   * and the result is false.
   *
   * Only what the room server accepted counts as known there, so a
   * publication that failed is made again by the next call. A local room
   * runs in this desktop, costs no request, and counts an agent as active
   * for only 45 seconds after a publication: it gets every publication.
   */
  async publishIfDue(
    entryId: string,
    method: string,
    status: NativeActivityStatus,
    observedAt = new Date().toISOString(),
  ): Promise<boolean> {
    const binding = await this.ports.bindings.get(entryId);
    if (!binding || !this.roomHas(entryId, binding, status)) return this.publish(entryId, method, status, observedAt);
    // As publish does for an idle agent: its line is gone with the turn.
    if (status === "idle") this.summaries.reset(entryId);
    return false;
  }

  /** Whether the room has this status, and this activity line, from this binding, and not for too long. */
  private roomHas(entryId: string, binding: WorkerSessionBinding, status: NativeActivityStatus): boolean {
    const last = this.accepted.get(entryId);
    if (!last || isLocalRoomApi(binding.api_url) || !sameBinding(last, binding) || last.status !== status) return false;
    // The other status is on its way to the room and can arrive after this
    // decision. This status must go out too: it gets the higher sequence, so
    // the server keeps it.
    if (this.inFlight.get(entryId)?.[status === "working" ? "idle" : "working"]) return false;
    if (status === "working" && last.activitySummary !== this.summaries.peek(entryId)) return false;
    const ageMs = this.nowMs() - last.sentAtMs;
    // A clock that was set back must not hold a refresh off.
    return ageMs >= 0 && ageMs < nativeActivityRefreshAfterMs(this.heartbeatIntervalMs, status);
  }

  private countInFlight(entryId: string, status: NativeActivityStatus, change: 1 | -1): void {
    const counts = this.inFlight.get(entryId) ?? { working: 0, idle: 0 };
    counts[status] += change;
    if (counts.working || counts.idle) this.inFlight.set(entryId, counts);
    else this.inFlight.delete(entryId);
  }

  async publish(
    entryId: string,
    method: string,
    status: NativeActivityStatus,
    observedAt = new Date().toISOString(),
  ): Promise<boolean> {
    // From this call until the room server has answered, publishIfDue must
    // not take what the server accepted before for what the room has.
    this.countInFlight(entryId, status, 1);
    try {
      return await this.send(entryId, method, status, observedAt);
    } finally {
      this.countInFlight(entryId, status, -1);
    }
  }

  private async send(entryId: string, method: string, status: NativeActivityStatus, observedAt: string): Promise<boolean> {
    const safeMethod = redactCredentialText(method, 160).value;
    const observedMs = Date.parse(observedAt);
    const currentBinding = await this.ports.bindings.get(entryId);
    if (!currentBinding || !await this.ports.bindings.credentialFor(currentBinding)) return false;
    // An idle agent does nothing to describe; its line is gone with the turn.
    if (status === "idle") this.summaries.reset(entryId);
    const activitySummary = status === "working" ? this.summaries.take(entryId) : null;
    const sentAtMs = this.nowMs();
    const publication = await this.ports.bindings.publish(
      entryId,
      observedMs,
      async ({ binding, sequence, observed_at }) => {
        const credential = await this.ports.bindings.credentialFor(binding);
        if (!credential) {
          throw new Error("Worker credential is unavailable until desktop credential delivery.");
        }
        const accepted = await (this.ports.publishWorkerActivity ?? publishWorkerNativeActivity)({
          apiUrl: binding.api_url,
          roomId: binding.room_id,
          agentSessionId: binding.agent_session_id,
          bearer: credential,
          observedAt: observed_at,
          sequence,
          method: safeMethod,
          status,
          operation: "the daemon bridge",
          activitySummary,
        });
        this.noteAnswer(entryId, accepted ? {
          room_id: binding.room_id,
          agent_session_id: binding.agent_session_id,
          execution_generation_id: binding.execution_generation_id,
          sequence, status, activitySummary, sentAtMs,
        } : null);
        return { accepted };
      },
    ).catch((error: unknown) => {
      // The request may have reached the server or not: what the room has is no longer known.
      this.accepted.delete(entryId);
      throw error;
    });
    if (!publication) return false;
    if (!publication.accepted) {
      throw new NativeActivityRejectedError("Native activity endpoint rejected a stale daemon observation.", null);
    }
    const verifiedBinding = await this.ports.bindings.get(entryId);
    if (verifiedBinding
      && verifiedBinding.room_id === currentBinding.room_id
      && verifiedBinding.work_attempt_id === currentBinding.work_attempt_id
      && verifiedBinding.execution_generation_id === currentBinding.execution_generation_id
      && verifiedBinding.agent_session_id === currentBinding.agent_session_id) {
      let recoveredCredentialHandoff = false;
      await this.ports.updateEntry(entryId, (current) => {
        // The callback may run twice; only the last run counts.
        recoveredCredentialHandoff = false;
        const recoversCredentialHandoff = awaitsCredentialHandoff(current)
          && current.room_id === verifiedBinding.room_id
          && current.work_attempt_id === verifiedBinding.work_attempt_id
          && current.provider_ref?.execution_generation_id === verifiedBinding.execution_generation_id;
        if (!recoversCredentialHandoff) return current;
        recoveredCredentialHandoff = true;
        const confirmedAt = publication.observed_at;
        return {
          ...current,
          observed_state: "working",
          condition: "none",
          last_error: null,
          ready_reached_at: resolveReadyReachedAt(current, true, confirmedAt),
          workplace_liveness: {
            state: "reachable",
            observed_at: confirmedAt,
            detail: "scoped worker bearer verified",
          },
        };
        // Reads only scalar fields, so the lock-held read can skip the events.
      }, { readsNoActivity: true });
      if (recoveredCredentialHandoff) {
        void this.ports.startDelivery(entryId).catch(() => undefined);
      }
    }
    return true;
  }

  /**
   * Remember the server's answer to one publication, for publishIfDue. A
   * publication that the server refused leaves nothing known. Publications
   * of one binding can end out of order, and the server keeps the one with
   * the highest sequence.
   */
  private noteAnswer(entryId: string, accepted: AcceptedActivity | null): void {
    const last = this.accepted.get(entryId);
    if (!accepted) this.accepted.delete(entryId);
    else if (!last || !sameBinding(last, accepted) || last.sequence <= accepted.sequence) this.accepted.set(entryId, accepted);
  }
}

import { reactive } from "vue";
import type { DesktopHostApproval, HostApprovalSelection, HostApprovalStatus } from "../../../../../../shared/host-approvals";
import { desktopIpc } from "../../../../ipc";
import { reuseUnchanged } from "../../../../domain/reuse-unchanged";

export interface HostApprovalRoomState {
  approvals: DesktopHostApproval[];
  error: string | null;
  loading: boolean;
  /** The one presentation whose decision is being recorded. */
  busy: string | null;
  /** When this desktop first listed each request, by hostApprovalIdentity; approvals carry no request time. */
  firstSeenAt: Record<string, string>;
  /** The last listing failed: main no longer holds these presentations, so none can be decided. */
  stale: boolean;
  /** The decision this desktop sent for each request, by hostApprovalIdentity, so an unconfirmed card can name it. */
  decisions: Record<string, HostApprovalSelection>;
}

/**
 * One copy of each room's host approvals, shared by the composer card and the
 * Inbox, so a decision made on either surface shows on both and counts once.
 */
const rooms = reactive(new Map<string, HostApprovalRoomState>());
const mutations = new Map<string, number>();
const pendingReads = new Map<string, Promise<void>>();
const EMPTY_ROOM: Readonly<HostApprovalRoomState> = Object.freeze({
  approvals: [], error: null, loading: false, busy: null, firstSeenAt: {}, stale: false, decisions: {},
});
/** Main refuses a decision on a presentation it has replaced, expired or already decided. */
const CHANGED_REQUEST = /refresh the approval|approval was refreshed|approval changed|different decision is already recorded/i;
let generation = 0;

/** Poll cadence. Fast while a request needs an answer, slow when the room is quiet. */
export const HOST_APPROVAL_ACTIVE_POLL_MS = 3_000;
export const HOST_APPROVAL_IDLE_POLL_MS = 15_000;
/** When each room's last listing began; the state-push throttle reads it. */
const lastReadStartedAt = new Map<string, number>();
/** Composer ticks (every HOST_APPROVAL_ACTIVE_POLL_MS) seen since each room's last listing began. */
const ticksSinceRead = new Map<string, number>();
/** Whether any agent of the room is in a running turn, from the last supervisor state push. */
const roomAgentsBusy = new Map<string, boolean>();
/** A push arrived while a listing was in flight: run one more listing when it ends. */
const rerunAfterRead = new Set<string>();
/** One trailing listing per room for a push the throttle held back. */
const trailingReads = new Map<string, ReturnType<typeof setTimeout>>();
const RUNNING_TURN_STATES = new Set(["dispatching", "responding", "publishing", "retrying"]);

/**
 * Called once per composer tick. Returns true when a listing is due.
 *
 * Each listing costs main a storage lookup, two daemon requests and a signature.
 * List on every tick (3 s) only while an approval is open, a decision is in
 * flight, an unresolved or unavailable card is shown, an agent of the room is in a
 * running turn, or the last listing failed. Otherwise list on every fifth tick (15 s).
 * A supervisor state push also asks for a listing (`watchHostApprovalPushes`),
 * so a new request does not wait for the slow tick. Counting ticks, not clock
 * time, keeps the cadence tied to the timer that drives it.
 */
export function hostApprovalPollDue(roomIdentifier: string): boolean {
  const ticks = (ticksSinceRead.get(roomIdentifier) ?? Infinity) + 1;
  ticksSinceRead.set(roomIdentifier, ticks);
  if (!lastReadStartedAt.has(roomIdentifier)) return true;
  const state = rooms.get(roomIdentifier);
  const needsAnswer = !state || state.busy !== null || state.stale || state.error !== null
    || roomAgentsBusy.get(roomIdentifier) === true
    || state.approvals.some(approval => approval.status === "pending" || approval.status === "decision_recorded"
      || approval.status === "unavailable" || approval.status === "uncertain");
  return ticks >= (needsAnswer ? 1 : HOST_APPROVAL_IDLE_POLL_MS / HOST_APPROVAL_ACTIVE_POLL_MS);
}

/**
 * Refresh the room's approvals when the supervisor pushes state that includes
 * this room's agents. The daemon pushes on every approval request and resolution.
 * - A push inside the active period of the last listing is not lost: one trailing
 *   listing runs when that period ends.
 * - A push during a listing runs one more listing right after it ends.
 * Also records whether an agent of the room is in a running turn, which keeps the
 * slow tick at 3 s. Returns the unsubscribe.
 */
export function watchHostApprovalPushes(roomIdentifier: string): () => void {
  const subscribe = desktopIpc.supervisor?.onState;
  if (!subscribe || !roomIdentifier) return () => undefined;
  const stop = subscribe((snapshot) => {
    roomAgentsBusy.set(roomIdentifier, snapshot.entries.some(entry =>
      entry.desiredState !== "stopped" && RUNNING_TURN_STATES.has(entry.roomAgentState?.turn?.state ?? "")));
    if (!snapshot.entries.length) return;
    requestPushRefresh(roomIdentifier);
  }, roomIdentifier);
  return () => {
    stop();
    const timer = trailingReads.get(roomIdentifier);
    if (timer) clearTimeout(timer);
    trailingReads.delete(roomIdentifier);
    rerunAfterRead.delete(roomIdentifier);
  };
}

function requestPushRefresh(roomIdentifier: string): void {
  if (pendingReads.has(roomIdentifier)) {
    rerunAfterRead.add(roomIdentifier);
    return;
  }
  const last = lastReadStartedAt.get(roomIdentifier);
  const wait = last === undefined ? 0 : last + HOST_APPROVAL_ACTIVE_POLL_MS - Date.now();
  if (wait <= 0) {
    void refreshHostApprovals(roomIdentifier);
    return;
  }
  if (trailingReads.has(roomIdentifier)) return;
  trailingReads.set(roomIdentifier, setTimeout(() => {
    trailingReads.delete(roomIdentifier);
    requestPushRefresh(roomIdentifier);
  }, wait));
}

/**
 * One request across presentations: main mints a new presentation ID when it
 * re-presents the same request, so rows and order follow the request instead.
 */
export function hostApprovalIdentity(approval: Pick<DesktopHostApproval, "id" | "requestKey">): string {
  return approval.requestKey ?? approval.id;
}

/** Read-only view; a room is added only once it has been listed. */
export function hostApprovalRoom(roomIdentifier: string | null | undefined): Readonly<HostApprovalRoomState> {
  return (roomIdentifier && rooms.get(roomIdentifier)) || EMPTY_ROOM;
}

export function hostApprovalRooms(): ReadonlyMap<string, Readonly<HostApprovalRoomState>> {
  return rooms;
}

/** Account changes and tests start from an empty view; in-flight reads are discarded. */
export function resetHostApprovals(): void {
  generation += 1;
  rooms.clear();
  mutations.clear();
  pendingReads.clear();
  lastReadStartedAt.clear();
  ticksSinceRead.clear();
  roomAgentsBusy.clear();
  rerunAfterRead.clear();
  for (const timer of trailingReads.values()) clearTimeout(timer);
  trailingReads.clear();
}

function roomState(roomIdentifier: string): HostApprovalRoomState {
  if (!rooms.has(roomIdentifier)) {
    rooms.set(roomIdentifier, { approvals: [], error: null, loading: false, busy: null, firstSeenAt: {}, stale: false, decisions: {} });
  }
  return rooms.get(roomIdentifier)!;
}

export function refreshHostApprovals(roomIdentifier: string): Promise<void> {
  const pending = pendingReads.get(roomIdentifier);
  if (pending) return pending;
  const read = readHostApprovals(roomIdentifier);
  pendingReads.set(roomIdentifier, read);
  void read.then(() => {
    if (pendingReads.get(roomIdentifier) !== read) return;
    pendingReads.delete(roomIdentifier);
    if (rerunAfterRead.delete(roomIdentifier)) void refreshHostApprovals(roomIdentifier);
  });
  return read;
}

async function readHostApprovals(roomIdentifier: string): Promise<void> {
  const read = desktopIpc.supervisor?.listHostApprovals;
  if (!roomIdentifier || !read) return;
  const state = roomState(roomIdentifier);
  if (state.loading || state.busy) return;
  const epoch = generation;
  const mutation = mutations.get(roomIdentifier) ?? 0;
  state.loading = true;
  lastReadStartedAt.set(roomIdentifier, Date.now());
  ticksSinceRead.set(roomIdentifier, 0);
  try {
    const snapshot = await read(roomIdentifier);
    // A decision started during this read owns the newer status.
    if (epoch !== generation || mutation !== (mutations.get(roomIdentifier) ?? 0)) return;
    if (snapshot.available) {
      // Unchanged data keeps its old references, so an unchanged poll triggers nothing.
      state.approvals = reuseUnchanged(state.approvals, snapshot.approvals);
      const now = new Date().toISOString();
      const firstSeenAt = Object.fromEntries(snapshot.approvals.map(approval => {
        const identity = hostApprovalIdentity(approval);
        return [identity, state.firstSeenAt[identity] ?? now];
      }));
      state.firstSeenAt = reuseUnchanged(state.firstSeenAt, firstSeenAt);
    }
    state.stale = !snapshot.available;
    state.error = snapshot.available ? snapshot.error
      : snapshot.error ?? "Host approvals are unavailable. Decisions are disabled until the service reconnects.";
  } catch {
    if (epoch === generation && mutation === (mutations.get(roomIdentifier) ?? 0)) {
      state.stale = true;
      state.error = "Could not refresh host approvals. Decisions are disabled until the service reconnects.";
    }
  } finally {
    if (epoch === generation) state.loading = false;
  }
}

/** Records the decision and returns the status main reports, or null when none was confirmed. */
export async function decideHostApproval(roomIdentifier: string, id: string, decision: HostApprovalSelection): Promise<HostApprovalStatus | null> {
  const decide = desktopIpc.supervisor?.decideHostApproval;
  const state = rooms.get(roomIdentifier);
  if (!decide || !state || state.busy || state.error) return null;
  const epoch = generation;
  mutations.set(roomIdentifier, (mutations.get(roomIdentifier) ?? 0) + 1);
  state.busy = id;
  const decided = state.approvals.find(item => item.id === id);
  const identity = decided ? hostApprovalIdentity(decided) : null;
  if (identity) state.decisions = { ...state.decisions, [identity]: decision };
  try {
    const status = await decide({ id, decision });
    if (epoch !== generation) return null;
    const approval = state.approvals.find(item => item.id === id);
    if (approval) {
      approval.status = status;
      if (status !== "decision_recorded") approval.retryDecision = null;
    }
    return status;
  } catch (error) {
    const changed = CHANGED_REQUEST.test(error instanceof Error ? error.message : String(error));
    if (epoch === generation) {
      state.error = changed
        ? "This request changed. Refresh approvals to see its current state."
        : "Could not confirm the decision. Refresh approvals to check its recorded state.";
      // Main refused before sending: no decision is out there to confirm.
      if (changed && identity) {
        const { [identity]: _refused, ...rest } = state.decisions;
        state.decisions = rest;
      }
    }
    return null;
  } finally {
    if (epoch === generation) state.busy = null;
  }
}

import { reactive } from "vue";
import type { DesktopHostApproval, HostApprovalSelection } from "../../../../../../shared/host-approvals";
import { desktopIpc } from "../../../../ipc";

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
}

/**
 * One copy of each room's host approvals, shared by the composer card and the
 * Inbox, so a decision made on either surface shows on both and counts once.
 */
const rooms = reactive(new Map<string, HostApprovalRoomState>());
const mutations = new Map<string, number>();
const pendingReads = new Map<string, Promise<void>>();
const EMPTY_ROOM: Readonly<HostApprovalRoomState> = Object.freeze({
  approvals: [], error: null, loading: false, busy: null, firstSeenAt: {}, stale: false,
});
/** Main refuses a decision on a presentation it has replaced, expired or already decided. */
const CHANGED_REQUEST = /refresh the approval|approval was refreshed|approval changed|different decision is already recorded/i;
let generation = 0;

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
}

function roomState(roomIdentifier: string): HostApprovalRoomState {
  if (!rooms.has(roomIdentifier)) {
    rooms.set(roomIdentifier, { approvals: [], error: null, loading: false, busy: null, firstSeenAt: {}, stale: false });
  }
  return rooms.get(roomIdentifier)!;
}

export function refreshHostApprovals(roomIdentifier: string): Promise<void> {
  const pending = pendingReads.get(roomIdentifier);
  if (pending) return pending;
  const read = readHostApprovals(roomIdentifier);
  pendingReads.set(roomIdentifier, read);
  void read.then(() => { if (pendingReads.get(roomIdentifier) === read) pendingReads.delete(roomIdentifier); });
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
  try {
    const snapshot = await read(roomIdentifier);
    // A decision started during this read owns the newer status.
    if (epoch !== generation || mutation !== (mutations.get(roomIdentifier) ?? 0)) return;
    if (snapshot.available) {
      if (JSON.stringify(snapshot.approvals) !== JSON.stringify(state.approvals)) state.approvals = snapshot.approvals;
      const now = new Date().toISOString();
      const firstSeenAt = Object.fromEntries(snapshot.approvals.map(approval => {
        const identity = hostApprovalIdentity(approval);
        return [identity, state.firstSeenAt[identity] ?? now];
      }));
      if (JSON.stringify(firstSeenAt) !== JSON.stringify(state.firstSeenAt)) state.firstSeenAt = firstSeenAt;
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

export async function decideHostApproval(roomIdentifier: string, id: string, decision: HostApprovalSelection): Promise<void> {
  const decide = desktopIpc.supervisor?.decideHostApproval;
  const state = rooms.get(roomIdentifier);
  if (!decide || !state || state.busy || state.error) return;
  const epoch = generation;
  mutations.set(roomIdentifier, (mutations.get(roomIdentifier) ?? 0) + 1);
  state.busy = id;
  try {
    const status = await decide({ id, decision });
    if (epoch !== generation) return;
    const approval = state.approvals.find(item => item.id === id);
    if (approval) {
      approval.status = status;
      if (status !== "decision_recorded") approval.retryDecision = null;
    }
  } catch (error) {
    if (epoch === generation) state.error = CHANGED_REQUEST.test(error instanceof Error ? error.message : String(error))
      ? "This request changed. Refresh approvals to see its current state."
      : "Could not confirm the decision. Refresh approvals to check its recorded state.";
  } finally {
    if (epoch === generation) state.busy = null;
  }
}

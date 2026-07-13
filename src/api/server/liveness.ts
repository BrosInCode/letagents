import {
  countBoardIntents,
  getActiveBoardManager,
  getLivenessAnnouncementCandidate,
  getReachableWorkerDeliverySessionForAgentSession,
  getRoomBoardSettings,
  getRoomLiveAgentSuppressionActorLabels,
  listActiveBoardManagerAssignments,
  listActiveBoardManagerCandidates,
  listLivenessAnnouncementCandidates,
  markAgentOfflineAnnounced,
  markAgentRecoveryAnnounced,
  promoteBoardManagerTx,
  recordBoardManagerAssignedEvent,
  recordBoardManagerReleasedEvent,
  releaseBoardManagerAssignmentTx,
  type BoardManagerAssignment,
} from "../db.js";
import {
  createBoardManagerFailoverSweeper,
  type BoardManagerFailoverResult,
} from "../rooms/board-manager-failover-sweep.js";
import {
  createLivenessSweeper,
  LIVENESS_SWEEP_INTERVAL_MS,
  type LivenessAnnouncementInput,
} from "../rooms/liveness-sweep.js";
import { emitProjectMessage } from "./events.js";

async function announceOffline(input: LivenessAnnouncementInput): Promise<void> {
  await emitProjectMessage(input.room_id, "letagents", input.text, {
    source: "agent_liveness",
    agent_prompt_kind: "auto",
    client_message_id: input.client_message_id,
    with_created_message_in_transaction: async (tx) => {
      await markAgentOfflineAnnounced(
        {
          room_id: input.room_id,
          delivery_key: input.delivery_key,
          announced_at: input.announced_at,
        },
        tx
      );
    },
  });
}

async function announceRecovery(input: LivenessAnnouncementInput): Promise<void> {
  await emitProjectMessage(input.room_id, "letagents", input.text, {
    source: "agent_liveness",
    client_message_id: input.client_message_id,
    with_created_message_in_transaction: async (tx) => {
      await markAgentRecoveryAnnounced(
        {
          room_id: input.room_id,
          delivery_key: input.delivery_key,
          announced_at: input.announced_at,
        },
        tx
      );
    },
  });
}

const livenessSweeper = createLivenessSweeper({
  listCandidates: (options) => listLivenessAnnouncementCandidates(options),
  getCandidate: getLivenessAnnouncementCandidate,
  getSuppressedActorLabels: getRoomLiveAgentSuppressionActorLabels,
  getActiveBoardManagerSessionId: async (roomId) =>
    (await getActiveBoardManager(roomId))?.agent_session_id ?? null,
  announceOffline,
  announceRecovery,
  onError: (roomId, error) => {
    console.error(`Liveness sweep failed for room ${roomId}:`, error);
  },
});

/** Fence lost inside the failover transaction: roll the announcement back quietly. */
class BoardManagerFailoverLostRace extends Error {
  constructor() {
    super("board manager failover lost the fence");
    this.name = "BoardManagerFailoverLostRace";
  }
}

const FAILOVER_ACTOR = "letagents:manager_failover";

async function announceFailover(input: {
  room_id: string;
  text: string;
  client_message_id: string;
  dead_assignment_id: string;
  successor_agent_session_id: string;
}): Promise<BoardManagerFailoverResult | null> {
  let released: BoardManagerAssignment | null = null;
  let promoted: BoardManagerAssignment | null = null;
  try {
    await emitProjectMessage(input.room_id, "letagents", input.text, {
      source: "agent_liveness",
      agent_prompt_kind: "auto",
      client_message_id: input.client_message_id,
      with_created_message_in_transaction: async (tx) => {
        released = await releaseBoardManagerAssignmentTx(tx, {
          assignment_id: input.dead_assignment_id,
          released_by: FAILOVER_ACTOR,
          reason: "Board Manager went offline; automatic failover.",
        });
        if (!released) {
          throw new BoardManagerFailoverLostRace();
        }
        promoted = await promoteBoardManagerTx(tx, {
          room_id: input.room_id,
          agent_session_id: input.successor_agent_session_id,
          assigned_by: FAILOVER_ACTOR,
        });
        if (!promoted) {
          throw new BoardManagerFailoverLostRace();
        }
      },
    });
  } catch (error) {
    if (error instanceof BoardManagerFailoverLostRace) {
      return null;
    }
    throw error;
  }

  // A deduped replay skips the hook: a prior transaction already performed
  // this exact failover, so there is nothing further to do here.
  return released && promoted ? { released, promoted } : null;
}

const boardManagerFailoverSweeper = createBoardManagerFailoverSweeper({
  listActiveManagerAssignments: listActiveBoardManagerAssignments,
  getManagerFailoverMode: async (roomId) => (await getRoomBoardSettings(roomId)).manager_failover,
  getDeliveryCandidate: getLivenessAnnouncementCandidate,
  listManagerCandidates: listActiveBoardManagerCandidates,
  isCandidateReachable: async (roomId, agentSessionId) =>
    Boolean(
      await getReachableWorkerDeliverySessionForAgentSession({
        room_id: roomId,
        agent_session_id: agentSessionId,
      })
    ),
  announceManagerOffline: async (input) => {
    await emitProjectMessage(input.room_id, "letagents", input.text, {
      source: "agent_liveness",
      agent_prompt_kind: "auto",
      client_message_id: input.client_message_id,
    });
  },
  announceFailover,
  countPendingIntents: (roomId) => countBoardIntents({ room_id: roomId, status: "pending" }),
  announcePendingIntents: async (input) => {
    await emitProjectMessage(input.room_id, "letagents", input.text, {
      source: "agent_liveness",
      agent_prompt_kind: "auto",
      client_message_id: input.client_message_id,
    });
  },
  recordFailoverEvents: async ({ room_id, result }) => {
    await recordBoardManagerReleasedEvent({
      room_id,
      released_by: FAILOVER_ACTOR,
      manager: result.released,
      reason: "Board Manager went offline; automatic failover.",
    });
    await recordBoardManagerAssignedEvent({
      room_id,
      assigned_by: FAILOVER_ACTOR,
      manager: result.promoted,
    });
  },
  onError: (roomId, error) => {
    console.error(`Board Manager failover sweep failed for room ${roomId}:`, error);
  },
});

let sweepTimer: NodeJS.Timeout | null = null;
let sweepInFlight = false;

export function startLivenessSweep(): void {
  if (sweepTimer) {
    return;
  }

  const tick = async () => {
    if (sweepInFlight) {
      return;
    }
    sweepInFlight = true;
    try {
      await livenessSweeper.sweepOnce();
    } catch (error) {
      console.error("Liveness sweep failed:", error);
    }
    try {
      await boardManagerFailoverSweeper.sweepOnce();
    } catch (error) {
      console.error("Board Manager failover sweep failed:", error);
    } finally {
      sweepInFlight = false;
    }
  };

  sweepTimer = setInterval(() => void tick(), LIVENESS_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopLivenessSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

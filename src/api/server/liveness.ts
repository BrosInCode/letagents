import {
  approveTaskCreateBoardIntent,
  claimBoardIntentEscalationTx,
  countBoardIntents,
  countRecentAutoApprovedIntents,
  getActiveBoardManager,
  getLivenessAnnouncementCandidate,
  getReachableWorkerDeliverySessionForAgentSession,
  getRoomBoardSettings,
  getRoomLiveAgentSuppressionActorLabels,
  listActiveBoardManagerAssignments,
  listActiveBoardManagerCandidates,
  listEscalationCandidateBoardIntents,
  listLivenessAnnouncementCandidates,
  markAgentOfflineAnnounced,
  markAgentRecoveryAnnounced,
  markBoardIntentAutoApprovedTx,
  promoteBoardManagerTx,
  recordBoardManagerAssignedEvent,
  recordBoardManagerReleasedEvent,
  releaseBoardManagerAssignmentTx,
  type BoardManagerAssignment,
  type Task,
} from "../db.js";
import {
  createBoardManagerFailoverSweeper,
  type BoardManagerFailoverResult,
} from "../rooms/board-manager-failover-sweep.js";
import { createIntentEscalationSweeper } from "../rooms/board-intent-escalation-sweep.js";
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
  // this exact failover. Log it — if the prior run crashed before its
  // post-commit follow-ups, this is the only trace that coordination events
  // or the pending-intents nudge may be missing.
  if (!released || !promoted) {
    console.warn(
      `Board Manager failover replay deduped for ${input.client_message_id}; post-commit follow-ups from the original run are not retried.`
    );
    return null;
  }
  return { released, promoted };
}

const boardManagerFailoverSweeper = createBoardManagerFailoverSweeper({
  listActiveManagerAssignments: listActiveBoardManagerAssignments,
  getManagerFailoverMode: async (roomId) => (await getRoomBoardSettings(roomId)).manager_failover,
  getDeliveryCandidate: getLivenessAnnouncementCandidate,
  listManagerCandidates: listActiveBoardManagerCandidates,
  getCandidateConnectionState: async (roomId, agentSessionId) => {
    const session = await getReachableWorkerDeliverySessionForAgentSession({
      room_id: roomId,
      agent_session_id: agentSessionId,
    });
    if (!session) {
      return "none";
    }
    return session.active_connection_count > 0 ? "live" : "grace";
  },
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

/** Fence lost inside the escalation transaction: roll the announcement back quietly. */
class IntentEscalationLostRace extends Error {
  constructor() {
    super("board intent escalation lost the fence");
    this.name = "IntentEscalationLostRace";
  }
}

const ESCALATION_ACTOR = "letagents:intent_escalation";

const intentEscalationSweeper = createIntentEscalationSweeper({
  listCandidates: (options) => listEscalationCandidateBoardIntents(options),
  hasReachableManager: async (roomId) => {
    const manager = await getActiveBoardManager(roomId);
    if (!manager) {
      return false;
    }
    return Boolean(
      await getReachableWorkerDeliverySessionForAgentSession({
        room_id: roomId,
        agent_session_id: manager.agent_session_id,
      })
    );
  },
  countRecentAutoApprovals: countRecentAutoApprovedIntents,
  autoApproveIntent: async (input) => {
    let approvedTask: Task | null = null;
    try {
      await emitProjectMessage(input.room_id, "letagents", input.text, {
        source: "agent_liveness",
        agent_prompt_kind: "auto",
        client_message_id: input.client_message_id,
        with_created_message_in_transaction: async (tx) => {
          const claimed = await claimBoardIntentEscalationTx(tx, {
            room_id: input.room_id,
            intent_id: input.intent_id,
          });
          if (!claimed) {
            throw new IntentEscalationLostRace();
          }
          const result = await approveTaskCreateBoardIntent(
            {
              room_id: input.room_id,
              intent_id: input.intent_id,
              decision_by: ESCALATION_ACTOR,
              reason: "Auto-approved: no Board Manager responded within the escalation window.",
            },
            tx
          );
          if (!result) {
            throw new IntentEscalationLostRace();
          }
          await markBoardIntentAutoApprovedTx(tx, {
            room_id: input.room_id,
            intent_id: input.intent_id,
          });
          approvedTask = result.task;
        },
      });
    } catch (error) {
      if (error instanceof IntentEscalationLostRace) {
        return null;
      }
      throw error;
    }

    if (!approvedTask) {
      console.warn(
        `Intent escalation replay deduped for ${input.client_message_id}; the intent was already escalated by a prior run.`
      );
      return null;
    }
    return approvedTask;
  },
  notifyHumans: async (input) => {
    let claimed = false;
    try {
      await emitProjectMessage(input.room_id, "letagents", input.text, {
        source: "agent_liveness",
        agent_prompt_kind: "auto",
        client_message_id: input.client_message_id,
        with_created_message_in_transaction: async (tx) => {
          claimed = await claimBoardIntentEscalationTx(tx, {
            room_id: input.room_id,
            intent_id: input.intent_id,
          });
          if (!claimed) {
            throw new IntentEscalationLostRace();
          }
        },
      });
    } catch (error) {
      if (error instanceof IntentEscalationLostRace) {
        return false;
      }
      throw error;
    }
    return claimed;
  },
  onError: (roomId, error) => {
    console.error(`Intent escalation sweep failed for room ${roomId}:`, error);
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
    }
    try {
      await intentEscalationSweeper.sweepOnce();
    } catch (error) {
      console.error("Intent escalation sweep failed:", error);
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

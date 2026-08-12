import {
  acceptProposedTaskTx,
  approveTaskCreateBoardIntent,
  assertBoardIntentAutoApprovalEligibilityTx,
  BoardIntentAutoApprovalIneligibleError,
  claimBoardIntentEscalationTx,
  countBoardIntents,
  countRecentAutoApprovedIntents,
  getRoomAgentPresence,
  listStalledRoomCandidates,
  markRoomStallNudgedTx,
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
  pruneStaleRoomAgentDeliveryInstances,
  markBoardIntentAutoApprovedTx,
  promoteBoardManagerTx,
  recordBoardManagerAssignedEvent,
  recordBoardManagerReleasedEvent,
  releaseBoardManagerAssignmentTx,
  type BoardManagerAssignment,
  type Task,
} from "../db.js";
import {
  getDueRoomOperationalContext,
  getLivenessRoomContexts,
} from "../db/coordination/due-room-context.js";
import {
  lockBoardManagerFailoverDeliveryKeysTx,
  rescheduleActiveBoardManagerAssignment,
} from "../db/coordination/board-manager-failover.js";
import { rescheduleEscalationCandidateBoardIntent } from "../db/coordination/board-intents.js";
import { rescheduleStalledRoomCandidate } from "../db/coordination/room-stall.js";
import { rescheduleLivenessAnnouncementCandidate } from "../db/presence/offline-announcements.js";
import {
  createBoardManagerFailoverSweeper,
  type BoardManagerFailoverResult,
} from "../rooms/board-manager-failover-sweep.js";
import {
  createIntentEscalationSweeper,
  INTENT_AUTO_APPROVE_MAX_PER_WINDOW,
  INTENT_AUTO_APPROVE_WINDOW_MS,
} from "../rooms/board-intent-escalation-sweep.js";
import {
  createRoomStallSweeper,
  selectRoomStallNudgeWorkerLabels,
} from "../rooms/room-stall-sweep.js";
import {
  createLivenessSweeper,
  LIVENESS_SWEEP_INTERVAL_MS,
  resolveOfflineAnnounceAfterMs,
  type LivenessAnnouncementInput,
} from "../rooms/liveness-sweep.js";
import { emitProjectMessage } from "./events.js";
import { workflowEffectBroker } from "../workflow-effects/runtime.js";

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
  rescheduleCandidate: rescheduleLivenessAnnouncementCandidate,
  getSuppressedActorLabels: getRoomLiveAgentSuppressionActorLabels,
  getActiveBoardManagerSessionId: async (roomId) =>
    (await getActiveBoardManager(roomId))?.agent_session_id ?? null,
  getRoomContexts: getLivenessRoomContexts,
  announceOffline,
  announceRecovery,
  offlineAnnounceAfterMs: resolveOfflineAnnounceAfterMs(
    process.env.LETAGENTS_LIVENESS_NOTICE_AFTER_MS
  ),
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
  dead_assignment_agent_session_id: string;
  dead_assignment_claimed_check_at: string | null;
  successor_agent_session_id: string;
}): Promise<BoardManagerFailoverResult | null> {
  if (!input.dead_assignment_claimed_check_at) return null;
  let released: BoardManagerAssignment | null = null;
  let promoted: BoardManagerAssignment | null = null;
  try {
    await emitProjectMessage(input.room_id, "letagents", input.text, {
      source: "agent_liveness",
      agent_prompt_kind: "auto",
      client_message_id: input.client_message_id,
      with_created_message_in_transaction: async (tx) => {
        await lockBoardManagerFailoverDeliveryKeysTx(tx, {
          room_id: input.room_id,
          dead_agent_session_id: input.dead_assignment_agent_session_id,
          successor_agent_session_id: input.successor_agent_session_id,
        });
        released = await releaseBoardManagerAssignmentTx(tx, {
          assignment_id: input.dead_assignment_id,
          released_by: FAILOVER_ACTOR,
          reason: "Board Manager went offline; automatic failover.",
          claimed_check_at: input.dead_assignment_claimed_check_at,
          require_unreachable_delivery: true,
        });
        if (!released) {
          throw new BoardManagerFailoverLostRace();
        }
        promoted = await promoteBoardManagerTx(tx, {
          room_id: input.room_id,
          agent_session_id: input.successor_agent_session_id,
          assigned_by: FAILOVER_ACTOR,
          require_reachable_delivery: true,
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
  rescheduleAssignment: rescheduleActiveBoardManagerAssignment,
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

async function hasReachableManager(roomId: string): Promise<boolean> {
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
}

const intentEscalationSweeper = createIntentEscalationSweeper({
  listCandidates: (options) => listEscalationCandidateBoardIntents(options),
  rescheduleCandidate: rescheduleEscalationCandidateBoardIntent,
  hasReachableManager,
  getReachableManagerRoomIds: async (roomIds) =>
    (await getDueRoomOperationalContext(roomIds)).reachable_manager_room_ids,
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
          // Time-of-use revalidation: the sweep's checks are a pre-filter
          // only. This re-verifies mode + manager unreachability and takes
          // the per-proposer advisory lock that makes the rate cap atomic
          // across sweepers and replicas.
          await assertBoardIntentAutoApprovalEligibilityTx(tx, {
            room_id: input.room_id,
            proposer_actor_key: input.proposer_actor_key,
            cap_window_ms: INTENT_AUTO_APPROVE_WINDOW_MS,
            cap_max: INTENT_AUTO_APPROVE_MAX_PER_WINDOW,
          });
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
          // Proposed tasks are unclaimable; escalation exists to unblock
          // claims, so the created task must land accepted.
          const accepted = await acceptProposedTaskTx(tx, {
            room_id: input.room_id,
            task_id: result.task.id,
          });
          if (!accepted) {
            throw new Error(`escalated task ${result.task.id} could not be accepted`);
          }
          await markBoardIntentAutoApprovedTx(tx, {
            room_id: input.room_id,
            intent_id: input.intent_id,
          });
          approvedTask = { ...result.task, status: "accepted" };
        },
      });
    } catch (error) {
      if (error instanceof IntentEscalationLostRace) {
        return null;
      }
      if (error instanceof BoardIntentAutoApprovalIneligibleError) {
        // State changed between selection and commit (manager reconnected,
        // mode flipped, or the cap filled). The announcement rolled back;
        // the next sweep re-evaluates and picks the right path.
        console.warn(
          `Intent escalation for ${input.client_message_id} aborted at commit time: ${error.reason}`
        );
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

/** Fence lost inside the stall-nudge transaction: roll the announcement back quietly. */
class RoomStallNudgeLostRace extends Error {
  constructor() {
    super("room stall nudge lost the fence");
    this.name = "RoomStallNudgeLostRace";
  }
}

const roomStallSweeper = createRoomStallSweeper({
  listStalledRooms: (options) => listStalledRoomCandidates(options),
  rescheduleRoom: rescheduleStalledRoomCandidate,
  hasReachableManager,
  getRoomContexts: getDueRoomOperationalContext,
  listLiveWorkerLabels: async (roomId) => {
    const presence = await getRoomAgentPresence(roomId, {
      limit: 20,
      excludeSupervisorManaged: true,
    });
    return selectRoomStallNudgeWorkerLabels({
      presence,
    });
  },
  announceStall: async (input) => {
    let nudged = false;
    try {
      await emitProjectMessage(input.room_id, "letagents", input.text, {
        source: "agent_liveness",
        agent_prompt_kind: "auto",
        client_message_id: input.client_message_id,
        with_created_message_in_transaction: async (tx) => {
          nudged = await markRoomStallNudgedTx(tx, {
            room_id: input.room_id,
            epoch: input.epoch,
          });
          if (!nudged) {
            throw new RoomStallNudgeLostRace();
          }
        },
      });
    } catch (error) {
      if (error instanceof RoomStallNudgeLostRace) {
        return false;
      }
      throw error;
    }
    return nudged;
  },
  onError: (roomId, error) => {
    console.error(`Room stall sweep failed for room ${roomId}:`, error);
  },
});

let sweepTimer: NodeJS.Timeout | null = null;
let sweepPromise: Promise<void> | null = null;

export function startLivenessSweep(): void {
  if (sweepTimer) {
    return;
  }

  const tick = async () => {
    if (sweepPromise) {
      return;
    }
    const run = (async () => {
      try {
      await pruneStaleRoomAgentDeliveryInstances();
      } catch (error) {
      console.error("Delivery instance cleanup failed:", error);
      }
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
      }
      try {
      await roomStallSweeper.sweepOnce();
      } catch (error) {
      console.error("Room stall sweep failed:", error);
      }
      try {
      await workflowEffectBroker.sweepOnce();
      } catch (error) {
      console.error("Workflow effect reconciliation sweep failed:", error);
      }
    })();
    const pending = run.finally(() => {
      if (sweepPromise === pending) sweepPromise = null;
    });
    sweepPromise = pending;
    await sweepPromise;
  };

  sweepTimer = setInterval(() => void tick(), LIVENESS_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export async function stopLivenessSweep(): Promise<void> {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  await sweepPromise;
}

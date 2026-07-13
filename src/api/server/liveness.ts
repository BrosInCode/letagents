import {
  getActiveBoardManager,
  getLivenessAnnouncementCandidate,
  getRoomLiveAgentSuppressionActorLabels,
  listLivenessAnnouncementCandidates,
  markAgentOfflineAnnounced,
  markAgentRecoveryAnnounced,
} from "../db.js";
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

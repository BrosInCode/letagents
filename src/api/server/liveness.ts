import {
  getActiveBoardManager,
  getRoomLiveAgentSuppressionActorLabels,
  listLivenessAnnouncementCandidates,
  markAgentOfflineAnnounced,
  markAgentRecoveryAnnounced,
} from "../db.js";
import {
  createLivenessSweeper,
  LIVENESS_SWEEP_INTERVAL_MS,
} from "../rooms/liveness-sweep.js";
import { emitProjectMessage } from "./events.js";

const livenessSweeper = createLivenessSweeper({
  listCandidates: (options) => listLivenessAnnouncementCandidates(options),
  getSuppressedActorLabels: getRoomLiveAgentSuppressionActorLabels,
  getActiveBoardManagerSessionId: async (roomId) =>
    (await getActiveBoardManager(roomId))?.agent_session_id ?? null,
  markAgentOfflineAnnounced,
  markAgentRecoveryAnnounced,
  emitProjectMessage,
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

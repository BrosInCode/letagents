import type { DiagnosticsSnapshot, WorkerSnapshot } from "../../ipc-types.js";
import {
  buildWorkerSnapshots as buildLocalWorkerSnapshots,
  readLetAgentsLocalState,
} from "../../board-task-actions.js";
import { apiUrl, letagentsLocalStatePath } from "../paths.js";

export function buildWorkerSnapshots(): WorkerSnapshot[] {
  return buildLocalWorkerSnapshots(
    readLetAgentsLocalState(letagentsLocalStatePath),
  );
}

export function buildDiagnosticsSnapshot(): DiagnosticsSnapshot {
  return {
    apiUrl,
    localMode: "disabled",
    notes: [
      "This desktop app is using the same LetAgents service as the web app.",
      "Local-only storage is not part of this first version yet.",
      "Starting and stopping agents from the app is still being wired up.",
    ],
  };
}

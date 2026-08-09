import type {
  DesktopTaskSummary,
  WorkerSnapshot,
} from "../../../../../../electron/ipc-types";
import { normalizeActor, normalizeRoom } from "./formatters";

export function findLocalRoomWorker(
  workers: WorkerSnapshot[],
  roomIdentifier: string
): WorkerSnapshot | null {
  return workers.find((worker) =>
    worker.agentSessionId
    && normalizeRoom(worker.roomId) === normalizeRoom(roomIdentifier)
    && ["connected", "away"].includes(worker.state)
  ) || null;
}

export function taskMatchesLocalWorker(
  task: DesktopTaskSummary,
  worker: WorkerSnapshot | null
): boolean {
  if (!worker) return false;
  const workerActors = [
    worker.agentKey,
    worker.agentSessionId,
    worker.actorLabel,
    worker.detail,
  ].map(normalizeActor).filter(Boolean);
  const taskActors = [
    task.assigneeAgentKey,
    task.assignee,
    ...task.activeLeases.flatMap((lease) => [
      lease.agentKey,
      lease.agentSessionId,
      lease.holderLabel,
    ]),
  ].map(normalizeActor).filter(Boolean);
  return taskActors.some((actor) => workerActors.includes(actor));
}

import {
  findTaskByPrUrl,
  findTaskByWorkflowArtifactMatches,
  getActiveTaskLeases,
  getFocusRoomsForParent,
  getTaskById,
  type Task,
} from "../../db.js";
import {
  leaseMatchesWorkflowArtifact,
} from "../../coordination-policy.js";
import {
  createRepoRoomEventTaskResolver,
} from "../../repo-event-task-resolution.js";

export const { resolveLinkedTaskForRepoRoomEvent } = createRepoRoomEventTaskResolver({
  findTaskByWorkflowArtifactMatches,
  findTaskByPrUrl,
  findTaskByActiveWorkflowLease: async (projectId, workflow) => {
    const findTaskInRoom = async (roomId: string): Promise<Task | undefined> => {
      const leases = await getActiveTaskLeases(roomId);
      const lease = leases.find((candidate) =>
        candidate.kind === "work" &&
        leaseMatchesWorkflowArtifact({
          lease: candidate,
          prUrl: workflow.prUrl,
          branchRef: workflow.branchRef,
        })
      );
      return lease ? getTaskById(roomId, lease.task_id) : undefined;
    };

    const parentTask = await findTaskInRoom(projectId);
    if (parentTask) {
      return parentTask;
    }

    const focusRooms = await getFocusRoomsForParent(projectId);
    for (const focusRoom of focusRooms) {
      if (focusRoom.focus_status === "concluded") {
        continue;
      }
      const focusTask = await findTaskInRoom(focusRoom.id);
      if (focusTask) {
        return focusTask;
      }
    }

    return undefined;
  },
  getTaskById,
});

import {
  createCoordinationEvent,
  createTaskLease,
  getActiveFocusRoomForTask,
  getActiveTaskLeases,
  getActiveTaskLocks,
  getAgentIdentityByCanonicalKey,
  getFocusRoomsForParent,
  getOpenTasks,
  getProjectById,
  getRoomAgentPresence,
  getStaleTaskPromptMutes,
  getTasks,
  hasMessagesFromSender,
  upsertRoomParticipant,
  updateTaskLeaseWorkflowRefs,
} from "../db.js";
import { createGitHubFocusIsolationResolver } from "../github/focus-isolation.js";
import { createFocusParentBoardWriteIsolationEnforcer } from "../focus-rooms/task-write-isolation.js";
import { createRoomParticipantRecorder } from "../rooms/participants.js";
import { createStaleWorkPromptEmitter } from "../tasks/stale-work.js";
import { createTaskActivityMessageEmitters } from "../tasks/activity-messages.js";
import { createTaskCoordinationEnforcement } from "../tasks/coordination-enforcement.js";
import { emitProjectMessage } from "./events.js";

export const {
  rememberHumanRoomParticipant,
  rememberAgentRoomParticipant,
  rememberRoomParticipantFromMessage,
} = createRoomParticipantRecorder({ upsertRoomParticipant });

export const {
  getActiveTaskFocusRoom,
  emitTaskAnchoredMessage,
  emitGitHubEventToAllParentRepoFocusRooms,
  emitTaskLifecycleStatusMessage,
} = createTaskActivityMessageEmitters({
  getProjectById: async (projectId) => (await getProjectById(projectId)) ?? null,
  getActiveFocusRoomForTask: async (projectId, taskId) =>
    (await getActiveFocusRoomForTask(projectId, taskId)) ?? null,
  getFocusRoomsForParent,
  emitProjectMessage,
});

export const {
  getFocusRoomForGitHubEventTask,
  getHardIsolatedFocusRoomForGitHubEvent,
} = createGitHubFocusIsolationResolver({
  getActiveTaskFocusRoom,
  getProjectById: async (projectId) => (await getProjectById(projectId)) ?? null,
});

export const { maybeEmitStaleWorkPrompt } = createStaleWorkPromptEmitter({
  getOpenTasks,
  getRoomAgentPresence,
  getStaleTaskPromptMutes: async (projectId, options) =>
    getStaleTaskPromptMutes(projectId, options.taskIds),
  emitTaskAnchoredMessage,
});

export const enforceFocusParentBoardWriteIsolation =
  createFocusParentBoardWriteIsolationEnforcer({
    getProjectById,
  });

const taskCoordinationEnforcement = createTaskCoordinationEnforcement({
  getAgentIdentityByCanonicalKey,
  createCoordinationEvent,
  getActiveTaskLocks,
  getTasks,
  getFocusRoomsForParent: async (parentRoomId) =>
    (await getFocusRoomsForParent(parentRoomId)).map((focusRoom) => ({
      room_id: focusRoom.id,
      focus_key: focusRoom.focus_key,
      source_task_id: focusRoom.source_task_id,
      focus_status: focusRoom.focus_status,
    })),
  getActiveTaskLeases,
  createTaskLease,
  updateTaskLeaseWorkflowRefs,
});

export const {
  validateOwnerTokenTaskActorKey,
  recordCoordinationDecision,
  enforceTaskAdmissionCoordination,
  enforceTaskCoordinationMutation,
} = taskCoordinationEnforcement;

export async function isTrustedAgentCreator(
  projectId: string,
  createdBy: string
): Promise<boolean> {
  const normalizedSender = createdBy.trim().toLowerCase();
  if (!normalizedSender || normalizedSender === "human" || normalizedSender === "letagents") {
    return false;
  }

  return hasMessagesFromSender(projectId, createdBy);
}

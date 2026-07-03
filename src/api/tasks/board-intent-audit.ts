import {
  createCoordinationEvent,
  type BoardIntentActionType,
  type BoardIntentConsumptionInput,
} from "../db.js";
import type { CoordinationMutationKind } from "../coordination-policy.js";

export function boardIntentActionToCoordinationMutation(
  actionType: BoardIntentActionType
): CoordinationMutationKind {
  if (actionType === "task_create") return "task_admit";
  if (actionType === "task_claim") return "task_claim";
  return "task_update";
}

export async function recordBoardIntentConsumptionFailure(input: {
  roomId: string;
  taskId: string | null;
  approval: BoardIntentConsumptionInput | null | undefined;
  error: { message: string };
  actorLabel: string | null;
  actorKey: string | null;
  actorInstanceId: string | null;
}): Promise<void> {
  if (!input.approval) {
    return;
  }

  await createCoordinationEvent({
    room_id: input.roomId,
    task_id: input.taskId,
    event_type: boardIntentActionToCoordinationMutation(input.approval.action_type),
    decision: "deny",
    actor_label: input.actorLabel,
    actor_key: input.actorKey,
    actor_instance_id: input.actorInstanceId,
    reason: `Board intent approval consumption failed: ${input.error.message}`,
  });
}

import type { ActivityEvent } from "../../rental/activity-emitter.js";

export function rentalActivityPayload(
  projectId: string,
  activity: ActivityEvent,
): Record<string, unknown> {
  return {
    room_id: projectId,
    activity: {
      ...activity,
      room_id: projectId,
    },
  };
}

export function rentalActivityStreamNames(activity: ActivityEvent): string[] {
  const names = ["rental_activity"];
  if (
    activity.event_type.startsWith("patch.") ||
    activity.event_type.startsWith("patch_gate.") ||
    activity.event_type.startsWith("edit.")
  ) {
    names.push("rental_patch");
  }
  if (
    activity.event_type.startsWith("budget.") ||
    activity.event_type.startsWith("command.")
  ) {
    names.push("rental_usage");
  }
  return names;
}

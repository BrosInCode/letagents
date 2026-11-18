import { wordInitials } from "../../../../domain/initials";

export { livenessCapabilityLabel } from "../../../../../../../../shared/ui/liveness-labels";
export { taskStatusLabel } from "../../../../../../../../shared/ui/task-status";

export function initials(value: string): string {
  return wordInitials(value, "A");
}

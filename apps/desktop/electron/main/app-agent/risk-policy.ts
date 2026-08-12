import type {
  DesktopAppAgentActionPlan,
  DesktopAppAgentActionRisk,
} from "../../ipc-types.js";

import type { AppAgentActionDefinition } from "./types.js";

export const lowRiskImmediateActionLimit = 5;
export function riskRank(risk: DesktopAppAgentActionRisk): number {
  if (risk === "destructive") return 3;
  if (risk === "medium") return 2;
  return 1;
}

export function maxRisk(
  risks: DesktopAppAgentActionRisk[],
): DesktopAppAgentActionRisk {
  return risks.reduce<DesktopAppAgentActionRisk>(
    (highest, risk) => riskRank(risk) > riskRank(highest) ? risk : highest,
    "low",
  );
}

export function actionOperationCount(
  actionId: string,
  input: Record<string, unknown>,
): number {
  if (
    actionId === "rooms.pin_many" ||
    actionId === "rooms.archive_many"
  ) {
    const roomIdentifiers = input.roomIdentifiers;
    return Array.isArray(roomIdentifiers) ? Math.max(1, roomIdentifiers.length) : 1;
  }
  return 1;
}

export function planOperationCount(plan: DesktopAppAgentActionPlan): number {
  return plan.actions.reduce(
    (total, action) => total + actionOperationCount(action.actionId, action.input),
    0,
  );
}

export function actionNeedsConfirmation(
  action: AppAgentActionDefinition,
  input: Record<string, unknown>,
): boolean {
  if (action.requiresConfirmation || action.risk !== "low") return true;
  return actionOperationCount(action.id, input) > lowRiskImmediateActionLimit;
}

export function planNeedsConfirmation(plan: DesktopAppAgentActionPlan): boolean {
  if (plan.risk !== "low") return true;
  return planOperationCount(plan) > lowRiskImmediateActionLimit;
}

import type {
  DesktopAccountRoomEntry,
  DesktopAppAgentActionMetadata,
  DesktopMcpInstallConfigPath,
} from "../../../../../electron/ipc-types";

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "room";
}

export function configPathStatusLabel(
  status: DesktopMcpInstallConfigPath["status"],
): string {
  if (status === "installed") return "ready";
  if (status === "needs_attention") return "repair";
  return "not installed";
}

export function actionRiskState(risk: DesktopAppAgentActionMetadata["risk"]): string {
  if (risk === "low") return "connected";
  if (risk === "medium") return "starting";
  return "failed";
}

export function actionRiskLabel(risk: DesktopAppAgentActionMetadata["risk"]): string {
  if (risk === "low") return "Low risk";
  if (risk === "medium") return "Review first";
  return "High risk";
}

export function actionCategoryLabel(category: DesktopAppAgentActionMetadata["category"]): string {
  return category === "rooms" ? "Rooms" : "Settings";
}

export function actionDisplayName(action: DesktopAppAgentActionMetadata): string {
  return action.displayName || readableActionId(action.id);
}

export function actionCapabilityName(action: DesktopAppAgentActionMetadata): string {
  return action.capabilityName || readableActionId(action.id);
}

export function actionDisplayDescription(action: DesktopAppAgentActionMetadata): string {
  return action.displayDescription || action.description;
}

export function actionRefreshTargetsLabel(action: DesktopAppAgentActionMetadata): string {
  const labels = action.refreshTargets.map((target) => {
    if (target === "rooms") return "room list";
    if (target === "active_room") return "current room";
    if (target === "foreground") return "visible app state";
    return "settings";
  });
  return labels.length
    ? `Updates ${labels.join(", ")} after it runs.`
    : "No visible update after it runs.";
}

export function readableActionId(actionId: string): string {
  return actionId
    .replace(/^[^.]+\./, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function lastOpenedLabel(room: DesktopAccountRoomEntry): string {
  if (!room.lastOpenedAt) return "No recent activity";
  const timestamp = new Date(room.lastOpenedAt);
  if (Number.isNaN(timestamp.getTime())) return "Recent";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

export function roleSourceLabel(room: DesktopAccountRoomEntry): string {
  const role = room.role === "admin" ? "Admin" : "Participant";
  if (room.archived) return `${role} · Left`;
  if (room.source === "create_invite") return `${role} · Created`;
  if (room.source === "open_room") return `${role} · Opened`;
  if (room.source === "agent") return `${role} · Agent activity`;
  if (room.source === "participant") return `${role} · Participant`;
  if (room.source === "focus") return `${role} · Focus activity`;
  return role;
}

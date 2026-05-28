import type { DesktopTaskSummary } from "../../../../../../electron/ipc-types";

export function readableStatus(status: string): string {
  return status
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function shortTaskId(taskId: string): string {
  const match = /^task_(\d+)$/i.exec(taskId.trim());
  return match ? `T${match[1]}` : taskId.replace(/^task_/i, "T");
}

export function compactPerson(value: string | null | undefined): string {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  const parts = normalized.split("|").map((part) => part.trim()).filter(Boolean);
  return parts[0] || normalized;
}

export function normalizeRoom(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

export function normalizeActor(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

export function staleSummary(task: DesktopTaskSummary): string {
  const state = task.stalePromptState;
  if (!state) return "";
  const reason = state.reason ? readableStatus(state.reason) : "Stale";
  const duration = formatStaleDuration(state.staleForMs);
  if (state.isStale && duration) return `${reason} for ${duration}`;
  if (state.isStale) return reason;
  return state.muted ? "Reminders muted" : "";
}

export function formatStaleDuration(value: number | null): string {
  if (!value || value < 0) return "";
  const minutes = Math.floor(value / 60_000);
  if (minutes < 1) return "less than 1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function relativeTime(value: string | null | undefined): string {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "recently";
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 45) return "just now";
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  const days = Math.floor(deltaSeconds / 86_400);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
}

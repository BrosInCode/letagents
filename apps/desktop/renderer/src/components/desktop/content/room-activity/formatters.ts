export function livenessCapabilityLabel(value: string | null | undefined): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "codex_app_server_runtime_stream") return "Codex app-server stream";
  if (normalized === "session_activity") return "Session activity";
  if (normalized === "process_observed") return "Process observed";
  if (normalized === "tool_bridge_only") return "Tool bridge";
  return "Liveness signal";
}

export function taskStatusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "A";
}

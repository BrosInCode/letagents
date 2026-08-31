/** Host-ephemeral native payloads. Never persist or publish these objects. */
export type CodexNativePermissionRequest = Readonly<{
  id: string | number; method: string; params?: unknown; connectionId: string;
}>;
export type OpenCodeNativePermissionRequest = {
  id: string; sessionID: string; permission: string; patterns: string[];
  metadata: Record<string, unknown>; always: string[]; tool?: { messageID: string; callID: string };
};
export type ProviderPermissionRequest =
  | { provider: "codex"; native: CodexNativePermissionRequest }
  | { provider: "open-model"; native: OpenCodeNativePermissionRequest };
export type ProviderPermissionObservation =
  | { type: "snapshot"; connectionId: string | null; requests: readonly ProviderPermissionRequest[] }
  | { type: "degraded" | "unavailable" };
/** Exact native proposed edits, host-ephemeral like the permission request. */
export type CodexPermissionFileChange = {
  path: string;
  kind: { type: "add" } | { type: "delete" } | { type: "update"; move_path: string | null };
  diff: string;
};
export type ProviderPermissionCorrelation = { outcome: "correlation_unproven" }
  | { outcome: "correlated"; providerContinuationId: string; providerTurnId: string; kind: "command" | "file_change";
    fileChanges?: readonly CodexPermissionFileChange[] };
export type ProviderPermissionDispatchOptions = { beforeNativeDispatch: () => Promise<void>; assertNativeDispatch?: () => void;
  expectedFileChanges?: readonly CodexPermissionFileChange[] };
export type ProviderPermissionReply = { outcome: "sent_unacknowledged"; nativeScope: "request" }
  | { outcome: "native_processed"; nativeScope: "request" | "session_pending" };

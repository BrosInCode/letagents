import type {
  DesktopRentalContextApproval,
  DesktopRentalExposure,
  DesktopRentalPatch,
  DesktopRentalPatchGateStatus,
  DesktopRentalSessionStatus,
} from "../../../../../../electron/ipc-types";

type PillState = "active" | "connected" | "failed" | "offline" | "starting";

const CANCELLABLE_SESSION_STATUSES = new Set<DesktopRentalSessionStatus>([
  "requested",
  "active",
  "budget_exhausted",
]);

const STARTING_SESSION_STATUSES = new Set<DesktopRentalSessionStatus>([
  "requested",
  "accepted",
  "provisioning",
  "blocked",
  "patch_review",
  "pr_opened",
  "budget_exhausted",
  "stale",
]);

export function canCancelSessionStatus(status: DesktopRentalSessionStatus): boolean {
  return CANCELLABLE_SESSION_STATUSES.has(status);
}

export function sessionStatusState(status: DesktopRentalSessionStatus): PillState {
  if (status === "active") return "active";
  if (status === "completed") return "connected";
  if (status === "failed") return "failed";
  if (STARTING_SESSION_STATUSES.has(status)) return "starting";
  return "offline";
}

export function patchState(status: DesktopRentalPatchGateStatus): PillState {
  if (status === "passed") return "connected";
  if (status === "passed_with_warnings" || status === "needs_renter_approval") return "starting";
  if (status === "needs_revision" || status === "rejected" || status === "timed_out") return "failed";
  return "offline";
}

export function patchCheckState(status: DesktopRentalPatch["checkResults"][number]["status"]): PillState {
  if (status === "passed") return "connected";
  if (status === "warning" || status === "running" || status === "pending") return "starting";
  if (status === "failed") return "failed";
  return "offline";
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function humanizeToken(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function rentalModeLabel(mode: string): string {
  return mode === "trusted_open" ? "Full workspace access" : "Limited access";
}

export function rentalContinuityLabel(mode: string): string {
  return mode === "full_transcript" ? "Full room transcript" : "Summary only";
}

export function contextRequestState(
  status: DesktopRentalContextApproval["status"],
): PillState {
  if (status === "approved") return "connected";
  if (status === "pending") return "starting";
  if (status === "denied") return "failed";
  return "offline";
}

export function isPendingContextRequest(
  request: DesktopRentalContextApproval,
): boolean {
  return request.status === "pending";
}

export function countPendingContextRequests(
  requests: DesktopRentalContextApproval[],
): number {
  return requests.filter(isPendingContextRequest).length;
}

export function exposureScanState(
  status: DesktopRentalExposure["secretScanStatus"],
): PillState {
  if (status === "passed") return "connected";
  if (status === "redacted") return "starting";
  return "failed";
}

export function exposureTypeLabel(
  type: DesktopRentalExposure["exposureType"],
): string {
  switch (type) {
    case "file":
      return "File read";
    case "search_result":
      return "Search result";
    case "directory_listing":
      return "Directory listing";
    case "command_output":
      return "Command output";
    default:
      return humanizeToken(type);
  }
}

export function canApprovePatch(patch: DesktopRentalPatch): boolean {
  if (patch.prUrl) return false;
  return ["passed", "passed_with_warnings", "needs_renter_approval"].includes(patch.gateStatus);
}

export function canRequestPatchChanges(patch: DesktopRentalPatch): boolean {
  if (patch.prUrl) return false;
  return ["pending", "passed", "passed_with_warnings", "needs_renter_approval"].includes(patch.gateStatus);
}

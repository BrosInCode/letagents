/** Only the host-authenticated socket uses these exact journal coordinates. */
export type HostApprovalReference = {
  requestId: string; requestVersion: number; requestSha256: string;
  agentId: string; roomId: string; executionGenerationId: string; runtimeGenerationId: string;
  turnId: string; providerContinuationId: string; providerTurnId: string;
  connectionId: string; nativeRequestId: string | number;
};
export type HostApprovalChoice = "allow_once" | "deny";
export type HostApprovalPresentation = {
  agentId: string; displayName: string; provider: "codex" | "open-model";
  title: "Run a command" | "Change files" | "Grant for this turn" | "Approval unavailable";
  /** Plain text, host-ephemeral only. Control characters are displayed literally. */
  details: string;
  denyScope: "request" | "session_pending";
};
export type HostApprovalStatus = "pending" | "decision_recorded" | "decision_sent" | "uncertain" | "resolved" | "unavailable";
export type HostApprovalCandidate = {
  reference: HostApprovalReference | null;
  presentation: HostApprovalPresentation;
  status: HostApprovalStatus;
  detail: string | null;
  /** Main-process recovery coordinates, never forwarded to the renderer. */
  recordedDecision: { decisionId: string; actorId: string; decision: HostApprovalChoice; projectionSha256: string | null } | null;
};
export type HostApprovalDecision = {
  expected: HostApprovalReference; decisionId: string; actorId: string;
  decision: HostApprovalChoice; projectionSha256: string;
};
/** Renderer receives a presentation handle, never a signing payload or key. */
export type DesktopHostApproval = {
  id: string; presentation: HostApprovalPresentation; status: HostApprovalStatus; detail: string | null;
  /** Only an already-recorded, provably undispatched decision may be retried. */
  retryDecision: HostApprovalChoice | null;
};
export type DesktopHostApprovalSnapshot = {
  available: boolean; approvals: DesktopHostApproval[]; error: string | null;
};

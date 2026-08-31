/** Private Electron-main to daemon authentication; never renderer authority. */
export type HostApprovalOperation = "list" | "decide";
export type HostApprovalChallenge = {
  daemonGeneration: number;
  bootNonce: string;
  keyFingerprint: string;
};
export type SignedHostApprovalRequest = { payload: string; signature: string };
export type AuthenticatedHostApprovalRequest = { operation: HostApprovalOperation; input: unknown };

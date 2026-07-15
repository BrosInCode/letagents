/**
 * Daemon-side mirror of the Electron ProviderAdapter.  P1e owns the
 * control-socket bridge; keeping this structural port here keeps reconciliation
 * outside Electron's failure domain.
 */
export type ProviderActionCapabilities = { resume: boolean; midTurnInjection: boolean; transcriptAccess: boolean; permissionPromptBridging: boolean; survivesRestart: boolean };
export type ProviderActionConnectionRef =
  | { kind: "codex_app_server"; url: string; pid: number | null; processIdentity?: string | null }
  | { kind: "claude_cli"; pid: number | null; processIdentity?: string | null }
  | { kind: "cursor_cli"; pid: number | null; processIdentity?: string | null };
export type ProviderActionRef = { workAttemptId: string; providerContinuationId: string; provider?: string; providerConnection?: ProviderActionConnectionRef | null };
export type ProviderActionSpawn = { workAttemptId: string; roomId: string; cwd: string; launchPolicy: unknown; provider?: string; agentDisplayName?: string; resumeFrom?: ProviderActionRef | null; actionId?: string; supervisorEntryId?: string; supervisorSocketPath?: string; supervisorExecutionGenerationId?: string; supervisorWorkerSession?: { agentSessionId: string; roomCursor: string | null } };
export type ProviderActionHandle = { workAttemptId: string; pid: number | null; providerContinuationId: string | null; providerConnection?: ProviderActionConnectionRef | null; observedState: "starting" | "working" | "idle" | "stopping" | "stopped" | "failed" };
export type ProviderActionTerminal = { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error" | "provider_quota"; providerContinuationId: string | null };
export type ProviderActionAttachment = { state: "attached"; handle: ProviderActionHandle } | { state: "absent" } | { state: "ambiguous"; reason: string };
export type ProviderActionStreamEvent = {
  workAttemptId: string;
  providerContinuationId: string | null;
  observedAt: string;
  sequence: number;
  provider: string;
  kind: string;
  method: string;
  payload: unknown;
  payloadTruncated: boolean;
  payloadRedacted: boolean;
  durablePayloadRef: string | null;
};

export interface ProviderActionPort {
  capabilities(workAttemptId: string, provider?: string): Promise<ProviderActionCapabilities>;
  spawn(request: ProviderActionSpawn): Promise<ProviderActionHandle>;
  attach(ref: ProviderActionRef): Promise<ProviderActionHandle | null>;
  /** Recover an intent journaled before dispatch, never by spawning a second child. */
  attachAction(actionId: string, workAttemptId: string): Promise<ProviderActionAttachment>;
  resume(ref: ProviderActionRef, request: ProviderActionSpawn): Promise<ProviderActionHandle>;
  poke(handle: ProviderActionHandle, message: string, options?: { actionId?: string }): Promise<void>;
  stop(handle: ProviderActionHandle, options?: { force?: boolean; graceMs?: number; actionId?: string }): Promise<ProviderActionTerminal>;
  onExit(handle: ProviderActionHandle, listener: (terminal: ProviderActionTerminal) => void): Promise<() => void>;
  onStream?(handle: ProviderActionHandle, listener: (event: ProviderActionStreamEvent) => void): Promise<() => void>;
}

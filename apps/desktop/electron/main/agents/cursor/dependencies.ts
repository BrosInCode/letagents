// Injectable seams of the Cursor provider adapter and their production defaults.

import { writeFileSync } from "node:fs";
import type { ProviderActivityEvent, ProviderStreamEvent } from "../provider-adapter.js";
import { assertCursorPersonalIdentity } from "../cursor-identity.js";
import { defaultLaunchTurn, type CursorCliChild } from "./turn-launcher.js";
import { requestCursorWrapperStop } from "./windows-turn.js";
import { defaultGetProcessIdentity, defaultSignalProcess } from "../provider-evidence.js";
import {
  bindCursorSupervisedIdentity,
  relocateCursorConversationNamespace,
  type CursorPersonalIdentity,
  type CursorManagedProfile,
  type CursorSupervisedProfileOptions,
} from "./managed-profile.js";
import { assertCursorSupervisedMcpAuthority } from "../cursor-mcp-authority.js";
import { readCursorAccountUsage, readCursorContext, readCursorUsageOwner } from "../cursor-usage.js";
import {
  createSupervisedWorkspaceGeneration,
  openSupervisedWorkspaceGeneration,
  recoverSupervisedWorkspaceGeneration,
  removeSupervisedWorkspaceGenerationReceipt,
} from "../supervised-workspace-generation.js";

export interface CursorProviderAdapterDependencies {
  launchTurn(input: { cursorBin: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; deferStart?: boolean; statePath?: string; workspaceGenerationManifestPath?: string; deniedReadPaths?: string[]; deniedReadSubpaths?: string[]; deniedReadMetadataPaths?: string[]; deniedReadWriteRegexes?: string[]; deniedWriteRegexes?: string[]; deniedWritePaths?: string[]; deniedWriteStructuralPaths?: string[]; deniedWriteSubpaths?: string[]; deniedExecSubpaths?: string[]; allowedWriteSubpaths?: string[]; allowedReadSubpaths?: string[]; allowedNetworkUnixSockets?: string[]; allowedInternalUnixSocketRoots?: string[]; mcpConnectorSocketPath?: string; mcpRuntimeEntryPath?: string; mcpRuntimeCwd?: string; mcpRuntimeEnv?: Readonly<Record<string, string>>; providerAuthorization?: string; restrictRemoteAuthority?: boolean; fullAccess?: boolean; nativeResumeSessionId?: string; testAgentUpstreamEndpoint?: string; testControlPlaneUpstreamEndpoint?: string; testMcpCapabilityTimeoutMs?: number; testStartupBarrier?: { path: string; stage: "mcp_listen" | "authority_listen" | "agent_listen" } }): CursorCliChild;
  attestSupervisedMcp(input: {
    cursorBin: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    writableProfileRoot: string;
    requiredReadableRoots?: string[];
    expectedServerName?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<void>;
  attestPersonalIdentity(input: {
    cursorBin: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    writableProfileRoot: string;
    requiredReadableRoots?: string[];
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<CursorPersonalIdentity>;
  bindPersonalIdentity(profile: CursorManagedProfile, identity: CursorPersonalIdentity): void;
  /** `identity`: the recorded birth; on Windows a pid this process does not hold is ended only with it. */
  signalProcess(pid: number, signal: NodeJS.Signals, identity?: string | null): void;
  /** null means verified absent; undefined means liveness could not be verified. */
  getProcessIdentity(pid: number): string | null | undefined;
  prepareTurnState(path: string): void;
  relocateConversationNamespace: typeof relocateCursorConversationNamespace;
  openWorkspaceGeneration: typeof openSupervisedWorkspaceGeneration;
  createWorkspaceGeneration: typeof createSupervisedWorkspaceGeneration;
  recoverWorkspaceGeneration: typeof recoverSupervisedWorkspaceGeneration;
  removeWorkspaceGenerationReceipt: typeof removeSupervisedWorkspaceGenerationReceipt;
  readUsageAccount: typeof readCursorAccountUsage;
  readUsageContext: typeof readCursorContext;
  readUsageOwner: typeof readCursorUsageOwner;
  now(): string;
}

export interface CursorProviderAdapterOptions {
  cursorBin?: string;
  dependencies?: Partial<CursorProviderAdapterDependencies>;
  activitySink?: (event: ProviderActivityEvent) => void;
  streamSink?: (event: ProviderStreamEvent) => void;
  /** Bound on waiting for the first stream event of a turn (startup preflight). */
  turnStartTimeoutMs?: number;
  /** SIGTERM → SIGKILL escalation window for stop() and the attach-path fence. */
  stopGraceMs?: number;
  /** Injectable so adapter tests never touch the user's real Cursor profile. */
  supervisedProfileFactory?: (input: {
    workAttemptId: string;
    cwd: string;
    /** Authorized room route, preserved through each disposable turn profile. */
    apiBaseUrl: string;
    /** Exact durable permission authority selected for the supervised lane. */
    permissionProfileId?: CursorSupervisedProfileOptions["permissionProfileId"];
    /** Prevent exact scratch workspaces from resolving an ancestor Git project. */
    exactWorkspaceOnly?: boolean;
    /** Disposable root for non-authoritative MCP inspection. */
    profileRoot?: string;
    /** Inspection profiles deliberately omit Cursor login credentials. */
    includeAuth?: boolean;
    /** Auth-only source already refreshed by a live identity attestation. */
    authSourceHomeDir?: string;
    identityAttestationOnly?: boolean;
    attestedPersonalIdentity?: CursorPersonalIdentity;
    exposeLoginCredentials?: boolean;
    /** Inspection profiles expose only an inert local MCP readiness probe. */
    inspectionOnly?: boolean;
    /** Development-only runtime entry already gated by the daemon. */
    devMcpServerEntryPath?: string;
    /** Credentialless validation runs outside the real repository. */
    mcpWorkingDirectory?: string;
    /** Exact bounded-turn coordinates explicitly written into final MCP config. */
    supervisorMcpEnv?: Readonly<Record<string, string>>;
    /** Per-turn stdio connector owned by the durable wrapper. */
    mcpConnectorSocketPath?: string;
  }) => CursorManagedProfile;
}

/**
 * Windows has no SIGTERM: for a wrapper this process holds, the stop request
 * is its IPC "terminate" message, and the tree is ended after the grace
 * period (requestCursorWrapperStop). SIGKILL, and any pid not held here,
 * keep the shared path: the process tree ended by its recorded birth.
 */
export function defaultCursorSignalProcess(pid: number, signal: NodeJS.Signals, identity?: string | null): void {
  if (signal === "SIGTERM" && process.platform === "win32" && requestCursorWrapperStop(pid)) return;
  defaultSignalProcess(pid, signal, identity);
}

export const DEFAULT_DEPENDENCIES: CursorProviderAdapterDependencies = {
  launchTurn: defaultLaunchTurn,
  attestSupervisedMcp: assertCursorSupervisedMcpAuthority,
  attestPersonalIdentity: assertCursorPersonalIdentity,
  bindPersonalIdentity: bindCursorSupervisedIdentity,
  signalProcess: defaultCursorSignalProcess,
  getProcessIdentity: defaultGetProcessIdentity,
  prepareTurnState: (path) => writeFileSync(path, "", { flag: "wx", mode: 0o600 }),
  relocateConversationNamespace: relocateCursorConversationNamespace,
  openWorkspaceGeneration: openSupervisedWorkspaceGeneration,
  createWorkspaceGeneration: createSupervisedWorkspaceGeneration,
  recoverWorkspaceGeneration: recoverSupervisedWorkspaceGeneration,
  removeWorkspaceGenerationReceipt: removeSupervisedWorkspaceGenerationReceipt,
  readUsageAccount: readCursorAccountUsage,
  readUsageContext: readCursorContext,
  readUsageOwner: readCursorUsageOwner,
  now: () => new Date().toISOString(),
};

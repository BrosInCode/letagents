import type { IpcMain } from "electron";

import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderModelsResult,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderPreflightInput,
  DesktopAgentProviderSetupInput,
  DesktopAgentProviderSetupResult,
  DesktopManagedAgentChangeSummary,
  DesktopManagedAgentInspectResult,
  DesktopManagedAgentPermissionDecisionInput,
  DesktopManagedAgentPermissionDecisionResult,
  DesktopManagedAgentRetryInput,
  DesktopManagedAgentSession,
  DesktopManagedAgentStartInput,
  DesktopManagedAgentStartResult,
  DesktopManagedAgentStopInput,
  DiagnosticsSnapshot,
  WorkerSnapshot,
} from "../../ipc-types.js";
import {
  getDesktopManagedAgentChangeSummary,
  inspectDesktopManagedAgentSession,
  listDesktopManagedAgentSessions,
  resolveDesktopManagedAgentPermissionRequest,
  retryDesktopManagedAgent,
  startDesktopManagedAgent,
  stopDesktopManagedAgent,
} from "../agents/codex-supervisor.js";
import { listDesktopAgentProviderModels } from "../agents/managed-agent-models.js";
import {
  listDesktopAgentProviders,
  runDesktopAgentProviderPreflight,
  runDesktopAgentProviderSetup,
} from "../agents/providers.js";
import { buildDiagnosticsSnapshot, buildWorkerSnapshots } from "../rooms.js";
import { assertDesktopUpdateMutationAllowed } from "../updates.js";

export function registerDesktopWorkerIpcHandlers(targetIpcMain: IpcMain): void {
  targetIpcMain.handle(
    "desktop:workers:list",
    async (): Promise<WorkerSnapshot[]> => buildWorkerSnapshots(),
  );
  targetIpcMain.handle(
    "desktop:workers:list-managed-agent-sessions",
    async (
      _event,
      roomIdentifier?: string | null,
    ): Promise<DesktopManagedAgentSession[]> =>
      listDesktopManagedAgentSessions(roomIdentifier ?? null),
  );
  targetIpcMain.handle(
    "desktop:workers:start-managed-agent",
    async (
      _event,
      input: DesktopManagedAgentStartInput,
    ): Promise<DesktopManagedAgentStartResult> => {
      assertDesktopUpdateMutationAllowed();
      return startDesktopManagedAgent(input);
    },
  );
  targetIpcMain.handle(
    "desktop:workers:stop-managed-agent",
    async (
      _event,
      input?: DesktopManagedAgentStopInput,
    ): Promise<DesktopManagedAgentSession | null> => {
      assertDesktopUpdateMutationAllowed();
      return stopDesktopManagedAgent(input ?? {});
    },
  );
  targetIpcMain.handle(
    "desktop:workers:retry-managed-agent",
    async (
      _event,
      input: DesktopManagedAgentRetryInput,
    ): Promise<DesktopManagedAgentSession | null> => {
      assertDesktopUpdateMutationAllowed();
      return retryDesktopManagedAgent(input);
    },
  );
  targetIpcMain.handle(
    "desktop:workers:inspect-managed-agent",
    async (
      _event,
      sessionId?: string | null,
      roomIdentifier?: string | null,
    ): Promise<DesktopManagedAgentInspectResult | null> =>
      inspectDesktopManagedAgentSession(sessionId ?? null, roomIdentifier ?? null),
  );
  targetIpcMain.handle(
    "desktop:workers:get-managed-agent-change-summary",
    async (
      _event,
      sessionId?: string | null,
      roomIdentifier?: string | null,
    ): Promise<DesktopManagedAgentChangeSummary | null> =>
      getDesktopManagedAgentChangeSummary(sessionId ?? null, roomIdentifier ?? null),
  );
  targetIpcMain.handle(
    "desktop:workers:resolve-managed-agent-permission",
    async (
      _event,
      input: DesktopManagedAgentPermissionDecisionInput,
    ): Promise<DesktopManagedAgentPermissionDecisionResult> => {
      assertDesktopUpdateMutationAllowed();
      return resolveDesktopManagedAgentPermissionRequest(input);
    },
  );
  targetIpcMain.handle(
    "desktop:workers:list-agent-providers",
    async (): Promise<DesktopAgentProvider[]> => listDesktopAgentProviders(),
  );
  targetIpcMain.handle(
    "desktop:workers:list-agent-provider-models",
    async (
      _event,
      providerId: DesktopAgentProviderId,
      input?: DesktopAgentProviderPreflightInput,
    ): Promise<DesktopAgentProviderModelsResult> =>
      listDesktopAgentProviderModels(providerId, input ?? {}),
  );
  targetIpcMain.handle(
    "desktop:workers:run-agent-provider-preflight",
    async (
      _event,
      providerId: DesktopAgentProviderId,
      input?: DesktopAgentProviderPreflightInput,
    ): Promise<DesktopAgentProviderPreflight> =>
      runDesktopAgentProviderPreflight(providerId, input ?? {}),
  );
  targetIpcMain.handle(
    "desktop:workers:run-agent-provider-setup",
    async (
      _event,
      providerId: DesktopAgentProviderId,
      input: DesktopAgentProviderSetupInput,
    ): Promise<DesktopAgentProviderSetupResult> => {
      assertDesktopUpdateMutationAllowed();
      return runDesktopAgentProviderSetup(providerId, input);
    },
  );
  targetIpcMain.handle(
    "desktop:diagnostics:get-snapshot",
    async (): Promise<DiagnosticsSnapshot> => buildDiagnosticsSnapshot(),
  );
}

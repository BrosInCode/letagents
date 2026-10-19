import type { IpcMain } from "electron";

import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderModelsResult,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderPreflightInput,
  DesktopAgentProviderSetupInput,
  DesktopAgentProviderSetupResult,
  DiagnosticsSnapshot,
  WorkerSnapshot,
} from "../../ipc-types.js";
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

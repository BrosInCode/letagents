import type { IpcMain } from "electron";

import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderModelsResult,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderPreflightInput,
  DesktopAgentProviderSetupInput,
  DesktopAgentProviderSetupResult,
  DesktopProviderSignInUpdate,
  DiagnosticsSnapshot,
  WorkerSnapshot,
} from "../../ipc-types.js";
import { listDesktopAgentProviderModels } from "../agents/managed-agent-models.js";
import {
  listDesktopAgentProviders,
  runDesktopAgentProviderPreflight,
  runDesktopAgentProviderSetup,
} from "../agents/providers.js";
import { desktopProviderSignIn } from "../agents/provider-sign-in.js";
import { isDesktopAgentProviderId } from "../agents/provider-registry.js";
import { buildDiagnosticsSnapshot, buildWorkerSnapshots } from "../rooms.js";
import { assertDesktopUpdateMutationAllowed } from "../updates.js";
import { emitToMainWindow } from "../window.js";
import { gateSupervisedAgentIpc } from "./supervised-agent-gate.js";

function signInProviderId(providerId: unknown): DesktopAgentProviderId {
  if (typeof providerId !== "string" || !isDesktopAgentProviderId(providerId)) {
    throw new Error(`Unknown agent provider: ${String(providerId)}`);
  }
  return providerId;
}

export function registerDesktopWorkerIpcHandlers(ipcMain: IpcMain): void {
  // Agent providers need supervised agents; the worker and diagnostics views do not.
  const targetIpcMain = gateSupervisedAgentIpc(ipcMain, {
    passThrough: ["desktop:workers:list", "desktop:diagnostics:get-snapshot"],
  });
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
  desktopProviderSignIn.onUpdate((update) => emitToMainWindow("desktop:workers:provider-sign-in-update", update));
  targetIpcMain.handle(
    "desktop:workers:start-provider-sign-in",
    async (_event, providerId: DesktopAgentProviderId): Promise<DesktopProviderSignInUpdate> => {
      assertDesktopUpdateMutationAllowed();
      return desktopProviderSignIn.start(signInProviderId(providerId));
    },
  );
  targetIpcMain.handle(
    "desktop:workers:submit-provider-sign-in-code",
    async (_event, providerId: DesktopAgentProviderId, code: string): Promise<DesktopProviderSignInUpdate> =>
      desktopProviderSignIn.submitCode(signInProviderId(providerId), code),
  );
  targetIpcMain.handle(
    "desktop:workers:cancel-provider-sign-in",
    async (_event, providerId: DesktopAgentProviderId): Promise<void> =>
      desktopProviderSignIn.cancel(signInProviderId(providerId)),
  );
  targetIpcMain.handle(
    "desktop:diagnostics:get-snapshot",
    async (): Promise<DiagnosticsSnapshot> => buildDiagnosticsSnapshot(),
  );
}

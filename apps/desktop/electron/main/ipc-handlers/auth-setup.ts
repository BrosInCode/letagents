import type { IpcMain } from "electron";

import type {
  DesktopAuthPollResult,
  DesktopAuthStartResult,
  DesktopAuthStatus,
  DesktopMcpInstallManyResult,
  DesktopMcpInstallResult,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
  DesktopProvisionSupervisorGrantInput,
  DesktopSecureStorageStatus,
  DesktopSupervisorGrantMetadata,
} from "../../ipc-types.js";
import {
  clearStoredAuth,
  getDesktopAuthStatus,
  pollDeviceAuthFlow,
  setAuthAuthorizedHandler,
  setAuthInvalidatedHandler,
  startDeviceAuthFlow,
} from "../auth.js";
import { openAllowedExternalUrl } from "../external-url.js";
import {
  buildMcpInstallState,
  completeMcpOnboarding,
  installLetAgentsMcpServer,
  installLetAgentsMcpServers,
  refreshInstalledLetAgentsMcpServerAuth,
} from "../mcp-setup.js";
import {
  refreshDesktopNotificationRegistration,
  unregisterDesktopNotificationAccount,
} from "../notifications.js";
import { clearJoinedRoomInfoCache } from "../rooms.js";
import {
  getDesktopSupervisorGrantMetadata,
  getDesktopSupervisorGrantStorageStatus,
  provisionDesktopSupervisorGrant,
  revokeDesktopSupervisorGrant,
} from "../supervisor-grant.js";

export function registerDesktopAuthAndSetupIpcHandlers(targetIpcMain: IpcMain): void {
  setAuthAuthorizedHandler(() => {
    clearJoinedRoomInfoCache();
    void refreshInstalledLetAgentsMcpServerAuth().catch(() => {});
    void refreshDesktopNotificationRegistration().catch(() => {});
  });
  setAuthInvalidatedHandler(() => {
    clearJoinedRoomInfoCache();
    void refreshInstalledLetAgentsMcpServerAuth().catch(() => {});
    void unregisterDesktopNotificationAccount().catch(() => {});
  });
  targetIpcMain.handle(
    "desktop:auth:get-status",
    async (): Promise<DesktopAuthStatus> => getDesktopAuthStatus(),
  );
  targetIpcMain.handle(
    "desktop:auth:start-device-flow",
    async (
      _event,
      roomIdentifier?: string | null,
    ): Promise<DesktopAuthStartResult> => startDeviceAuthFlow(roomIdentifier),
  );
  targetIpcMain.handle(
    "desktop:auth:poll-device-flow",
    async (_event, requestId?: string | null): Promise<DesktopAuthPollResult> =>
      pollDeviceAuthFlow(requestId),
  );
  targetIpcMain.handle(
    "desktop:auth:open-verification",
    async (_event, url: string): Promise<void> => {
      await openAllowedExternalUrl(url, ["github.com"]);
    },
  );
  targetIpcMain.handle(
    "desktop:auth:sign-out",
    async (): Promise<DesktopAuthStatus> => {
      clearJoinedRoomInfoCache();
      await unregisterDesktopNotificationAccount();
      await clearStoredAuth();
      await refreshInstalledLetAgentsMcpServerAuth().catch(() => {});
      return getDesktopAuthStatus();
    },
  );
  targetIpcMain.handle(
    "desktop:supervisor-grant:get",
    async (): Promise<DesktopSupervisorGrantMetadata | null> => getDesktopSupervisorGrantMetadata(),
  );
  targetIpcMain.handle(
    "desktop:supervisor-grant:get-storage-status",
    async (): Promise<DesktopSecureStorageStatus> => getDesktopSupervisorGrantStorageStatus(),
  );
  targetIpcMain.handle(
    "desktop:supervisor-grant:provision",
    async (_event, input: DesktopProvisionSupervisorGrantInput): Promise<DesktopSupervisorGrantMetadata> => provisionDesktopSupervisorGrant(input),
  );
  targetIpcMain.handle(
    "desktop:supervisor-grant:revoke",
    async (): Promise<void> => revokeDesktopSupervisorGrant(),
  );
  targetIpcMain.handle(
    "desktop:setup:get-mcp-install-state",
    async (): Promise<DesktopMcpInstallState> => buildMcpInstallState(),
  );
  targetIpcMain.handle(
    "desktop:setup:install-mcp-server",
    async (
      _event,
      targetId: DesktopMcpInstallTargetId,
    ): Promise<DesktopMcpInstallResult> =>
      installLetAgentsMcpServer(targetId),
  );
  targetIpcMain.handle(
    "desktop:setup:install-mcp-servers",
    async (
      _event,
      targetIds: DesktopMcpInstallTargetId[],
    ): Promise<DesktopMcpInstallManyResult> =>
      installLetAgentsMcpServers(targetIds),
  );
  targetIpcMain.handle(
    "desktop:setup:complete-mcp-onboarding",
    async (): Promise<DesktopMcpInstallState> => completeMcpOnboarding(),
  );
}

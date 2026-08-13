import electron from "electron";
import type { IpcMain } from "electron";
import { homedir } from "node:os";

import type {
  DesktopAppAgentRunInput,
  DesktopAppAgentRunResult,
  DesktopAppAgentSaveSettingsInput,
  DesktopAppAgentSettingsStatus,
  DesktopAppInfo,
  DesktopOpenModelSaveSettingsInput,
  DesktopOpenModelSettingsStatus,
  DesktopUpdateStatus,
} from "../../ipc-types.js";
import { getAppAgentSettingsStatus, saveAppAgentSettings } from "../app-agent/settings.js";
import { listDesktopAppAgentActions, runDesktopAppAgent } from "../app-agent/runner.js";
import { getOpenModelSettingsStatus, saveOpenModelSettings } from "../agents/open-model-settings.js";
import { openDesktopCredentialStorage } from "../credential-storage.js";
import { openAllowedExternalUrl, openExternalWebUrl } from "../external-url.js";
import { getGitHubPullRequestStats } from "../github-pr-stats.js";
import {
  getDesktopNotificationStatus,
  setDesktopNotificationsEnabled,
  takePendingDesktopNotificationActivation,
} from "../notifications.js";
import { apiUrl, workspaceRoot } from "../paths.js";
import { desktopUpdater } from "../updates.js";

const { app } = electron as typeof import("electron");

export function registerDesktopAppIpcHandlers(targetIpcMain: IpcMain): void {
  targetIpcMain.handle(
    "desktop:app:get-info",
    async (): Promise<DesktopAppInfo> => ({
      appName: "LetAgents Desktop",
      appVersion: app.getVersion(),
      platform: process.platform,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
      workspaceRoot,
      homePath: homedir(),
      apiUrl,
    }),
  );
  targetIpcMain.handle(
    "desktop:updates:get-status",
    async (): Promise<DesktopUpdateStatus> => desktopUpdater.getStatus(),
  );
  targetIpcMain.handle(
    "desktop:updates:check",
    async (): Promise<DesktopUpdateStatus> => desktopUpdater.check(),
  );
  targetIpcMain.handle(
    "desktop:updates:install",
    async (): Promise<DesktopUpdateStatus> => desktopUpdater.install(),
  );
  targetIpcMain.handle("desktop:notifications:get-status", async () => getDesktopNotificationStatus());
  targetIpcMain.handle(
    "desktop:notifications:set-enabled",
    async (_event, enabled: boolean) => setDesktopNotificationsEnabled(enabled === true),
  );
  targetIpcMain.handle(
    "desktop:notifications:take-pending-activation",
    async () => takePendingDesktopNotificationActivation(),
  );
  targetIpcMain.handle(
    "desktop:app:open-github-url",
    async (_event, url: string): Promise<void> => {
      await openAllowedExternalUrl(url, ["github.com"]);
    },
  );
  targetIpcMain.handle(
    "desktop:app:open-external-url",
    async (_event, url: string): Promise<void> => {
      await openExternalWebUrl(url);
    },
  );
  targetIpcMain.handle(
    "desktop:app:open-credential-storage",
    async (): Promise<void> => openDesktopCredentialStorage(),
  );
  targetIpcMain.handle(
    "desktop:app:get-github-pull-request-stats",
    async (_event, url: string) => getGitHubPullRequestStats(url),
  );
  targetIpcMain.handle(
    "desktop:app-agent:get-settings-status",
    async (): Promise<DesktopAppAgentSettingsStatus> =>
      getAppAgentSettingsStatus(),
  );
  targetIpcMain.handle(
    "desktop:app-agent:save-settings",
    async (
      _event,
      input: DesktopAppAgentSaveSettingsInput,
    ): Promise<DesktopAppAgentSettingsStatus> => saveAppAgentSettings(input),
  );
  targetIpcMain.handle(
    "desktop:app-agent:list-actions",
    async () => listDesktopAppAgentActions(),
  );
  targetIpcMain.handle(
    "desktop:app-agent:run",
    async (
      _event,
      input: DesktopAppAgentRunInput,
    ): Promise<DesktopAppAgentRunResult> => runDesktopAppAgent(input),
  );
  targetIpcMain.handle(
    "desktop:open-model:get-settings-status",
    async (): Promise<DesktopOpenModelSettingsStatus> =>
      getOpenModelSettingsStatus(),
  );
  targetIpcMain.handle(
    "desktop:open-model:save-settings",
    async (
      _event,
      input: DesktopOpenModelSaveSettingsInput,
    ): Promise<DesktopOpenModelSettingsStatus> => saveOpenModelSettings(input),
  );
}

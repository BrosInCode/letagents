import { app, dialog, protocol } from "electron";

import {
  retireLegacyCodexBackedOpenModelSessions,
} from "./main/agents/legacy-open-model-retirement.js";
import { handleAttachmentProtocolRequest } from "./main/attachments.js";
import { registerDesktopIpcHandlers } from "./main/ipc.js";
import { configureApplicationMenu } from "./main/menu.js";
import { DesktopQuitCoordinator } from "./main/desktop-quit.js";
import { startDesktopShellEnvironmentHydration } from "./main/desktop-shell-environment.js";
import {
  initializeDesktopNotifications,
  prepareDesktopNotificationLaunch,
  prepareDesktopNotifications,
} from "./main/notifications.js";
import { attachmentProtocolScheme } from "./main/paths.js";
import { stopDesktopRoomStream } from "./main/room-stream.js";
import { configureDesktopSmokeEnvironment, seedDesktopSmokeState } from "./main/smoke.js";
import { createWindow, getMainWindow, hasOpenWindows } from "./main/window.js";
import { supervisorDaemonClient } from "./main/supervisor-daemon.js";
import { supervisorGrantCoordinator } from "./main/supervisor-grant-coordinator.js";
import { desktopUpdater, initializeDesktopUpdates, stopDesktopUpdates } from "./main/updates.js";
import { stopActiveRentalProviderHostManager } from "./rental/provider-host-manager.js";
import { stopActiveRentalProviderEventPoller } from "./rental/provider-event-poller.js";

configureDesktopSmokeEnvironment();
prepareDesktopNotifications();

const desktopQuitCoordinator = new DesktopQuitCoordinator({
  prepareDaemonIfIdle: () => supervisorDaemonClient.prepareForDesktopQuitIfIdle(),
  stopAgentsAndPrepareDaemon: (agents) => supervisorDaemonClient.stopAgentsAndPrepareForDesktopQuit(agents),
  chooseForActiveAgents: async (agents) => {
    const count = agents.length;
    const options = {
      type: "question" as const,
      title: "Agents are still running",
      message: `${count} supervised agent${count === 1 ? " is" : "s are"} still active.`,
      detail: "You can leave the agents supervised in the background, stop them before quitting, or return to LetAgents.",
      buttons: ["Quit and Keep Agents Running", "Stop Agents and Quit", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    };
    const window = getMainWindow();
    const result = window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    return result.response === 0 ? "keep_running" : result.response === 1 ? "stop_and_quit" : "cancel";
  },
  chooseAfterFailure: async (error) => {
    const options = {
      type: "warning" as const,
      title: "Background shutdown could not be verified",
      message: "LetAgents could not safely finish its background shutdown.",
      detail: `${error.message}\n\nQuit anyway only if you are comfortable leaving supervised work running.`,
      buttons: ["Quit Anyway", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const window = getMainWindow();
    const result = window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    return result.response === 0 ? "quit_anyway" : "cancel";
  },
  cleanup: async () => {
    stopDesktopUpdates();
    const results = await Promise.allSettled([
      stopDesktopRoomStream(),
      stopActiveRentalProviderHostManager(),
      stopActiveRentalProviderEventPoller(),
    ]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason), "Desktop shutdown cleanup failed.");
  },
  quit: () => app.quit(),
  bypassForUpdate: () => desktopUpdater.isInstalling(),
  reportError: (error) => {
    console.warn(`Desktop quit cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  },
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: attachmentProtocolScheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

registerDesktopIpcHandlers();

app.once("ready", async (_event, launchInfo) => {
  prepareDesktopNotificationLaunch(launchInfo);
  const backgroundStartup = (async () => {
    await startDesktopShellEnvironmentHydration().catch((error) => {
      console.warn(`Desktop shell environment unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
    await retireLegacyCodexBackedOpenModelSessions().catch((error) => {
      console.warn(
        `Legacy Open Model retirement failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (process.platform === "darwin") {
      await supervisorDaemonClient.ensureRunning().catch((error) => {
        console.warn(`Supervisor daemon unavailable: ${error instanceof Error ? error.message : String(error)}`);
      });
      // Rehydrate only desired-running daemon-inbox Codex entries. A failure is
      // intentionally non-fatal to Electron: the paused/blocked daemon entry is
      // truthful and recovery remains available after sign-in/host authority.
      await supervisorGrantCoordinator.reconcileDesiredRunning().catch((error) => {
        console.warn(`Supervisor grant reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  })();
  if (process.env.LETAGENTS_PACKAGED_SUPERVISOR_SMOKE === "1") {
    await backgroundStartup;
    const status = await supervisorDaemonClient.ensureRunning();
    console.log(`LETAGENTS_PACKAGED_SUPERVISOR_READY ${JSON.stringify(status)}`);
    app.exit(0);
    return;
  }
  protocol.handle(attachmentProtocolScheme, handleAttachmentProtocolRequest);
  seedDesktopSmokeState();
  app.setName("LetAgents");
  configureApplicationMenu();
  createWindow();
  void backgroundStartup;
  initializeDesktopUpdates();
  await initializeDesktopNotifications().catch((error) => {
    console.warn(`Desktop notification setup unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });

  app.on("activate", () => {
    if (!hasOpenWindows()) {
      createWindow();
    }
  });
});

app.on("before-quit", (event) => {
  desktopQuitCoordinator.handleBeforeQuit(event);
});

app.on("window-all-closed", () => {
  void stopDesktopRoomStream();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

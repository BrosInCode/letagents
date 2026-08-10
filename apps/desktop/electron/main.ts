import { app, protocol } from "electron";

import {
  retireLegacyCodexBackedOpenModelSessions,
} from "./main/agents/legacy-open-model-retirement.js";
import { handleAttachmentProtocolRequest } from "./main/attachments.js";
import { registerDesktopIpcHandlers } from "./main/ipc.js";
import { configureApplicationMenu } from "./main/menu.js";
import {
  initializeDesktopNotifications,
  prepareDesktopNotificationLaunch,
  prepareDesktopNotifications,
} from "./main/notifications.js";
import { attachmentProtocolScheme } from "./main/paths.js";
import { stopDesktopRoomStream } from "./main/room-stream.js";
import { configureDesktopSmokeEnvironment, seedDesktopSmokeState } from "./main/smoke.js";
import { createWindow, hasOpenWindows } from "./main/window.js";
import { supervisorDaemonClient } from "./main/supervisor-daemon.js";
import { supervisorGrantCoordinator } from "./main/supervisor-grant-coordinator.js";
import { stopActiveRentalProviderHostManager } from "./rental/provider-host-manager.js";
import { stopActiveRentalProviderEventPoller } from "./rental/provider-event-poller.js";

configureDesktopSmokeEnvironment();
prepareDesktopNotifications();

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
  if (process.env.LETAGENTS_PACKAGED_SUPERVISOR_SMOKE === "1") {
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
  await initializeDesktopNotifications().catch((error) => {
    console.warn(`Desktop notification setup unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });

  app.on("activate", () => {
    if (!hasOpenWindows()) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  void stopDesktopRoomStream();
  void stopActiveRentalProviderHostManager();
  void stopActiveRentalProviderEventPoller();
});

app.on("window-all-closed", () => {
  void stopDesktopRoomStream();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

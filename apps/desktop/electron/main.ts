import { app, autoUpdater, protocol } from "electron";
import { join } from "node:path";

import { claimDesktopInstance, registerAskLinks } from "./main/ask-links.js";
import { handleAttachmentProtocolRequest } from "./main/attachments.js";
import { registerDesktopIpcHandlers } from "./main/ipc.js";
import { configureApplicationMenu } from "./main/menu.js";
import { startDesktopShellEnvironmentHydration } from "./main/desktop-shell-environment.js";
import {
  initializeDesktopNotifications,
  prepareDesktopNotificationLaunch,
  prepareDesktopNotifications,
  setDesktopNotificationBadgeCount,
} from "./main/notifications.js";
import { letagentsHomePath } from "../../../shared/letagents-home.mjs";
import { attachmentProtocolScheme, htmlDemoProtocolScheme, workspaceRoot } from "./main/paths.js";
import {
  setExecutionDelegationInvalidationHandler,
  stopDesktopRoomStream,
} from "./main/room-stream.js";
import { supervisedAgentsSupported, supervisorDaemonAllowed } from "./main/platform-capabilities.js";
import { configureDesktopSmokeEnvironment, seedDesktopSmokeState } from "./main/smoke.js";
import { allowMainWindowQuit, createWindow, focusMainWindow, hasOpenWindows } from "./main/window.js";
import { supervisorDaemonClient } from "./main/supervisor-daemon.js";
import { recordDesktopExit } from "./main/supervisor-daemon/lifecycle-log.js";
import { supervisorGrantCoordinator } from "./main/supervisor-grant-coordinator.js";
import { initializeDesktopUpdates, stopDesktopUpdates } from "./main/updates.js";
import { applyWindowsAppUserModelId, startWindowsSmokeNotification } from "./main/windows-app-identity.js";
import { stopActiveRentalProviderHostManager } from "./rental/provider-host-manager.js";
import { stopActiveRentalProviderEventPoller } from "./rental/provider-event-poller.js";

configureDesktopSmokeEnvironment();
// Off macOS a link starts a second instance: it hands the link to the running app and exits before starting anything.
if (claimDesktopInstance()) startDesktopApp();
else app.exit(0);

function startDesktopApp(): void {
  // Windows: before any window or notification, so toasts and the taskbar
  // use the ID the installer wrote on the app's shortcuts.
  applyWindowsAppUserModelId(app);
  prepareDesktopNotifications();
  registerAskLinks();

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
    {
      // Standard and secure so each demo window has its own origin and storage.
      scheme: htmlDemoProtocolScheme,
      privileges: { standard: true, secure: true },
    },
  ]);

  const startRentalServices = registerDesktopIpcHandlers();
  // Without supervised agents there is no daemon to hold execution delegations.
  if (supervisedAgentsSupported()) {
    setExecutionDelegationInvalidationHandler(async (roomId) => { await supervisorDaemonClient.syncExecutionDelegations(roomId); });
  }

  app.once("ready", async (_event, launchInfo) => {
    prepareDesktopNotificationLaunch(launchInfo);
    const startupPreparation = (async () => {
      await startDesktopShellEnvironmentHydration().catch((error) => {
        console.warn(`Desktop shell environment unavailable: ${error instanceof Error ? error.message : String(error)}`);
      });
    })();
    const backgroundStartup = (async () => {
      if (supervisorDaemonAllowed()) {
        // Register startup before opening the window, including its prerequisites,
        // so passive readers can wait for the same readiness operation.
        await supervisorDaemonClient.ensureRunning(startupPreparation).catch((error) => {
          console.warn(`Supervisor daemon unavailable: ${error instanceof Error ? error.message : String(error)}`);
        });
        // Rehydrate only desired-running daemon-inbox Codex entries. A failure is
        // intentionally non-fatal to Electron: the paused/blocked daemon entry is
        // truthful and recovery remains available after sign-in/host authority.
        if (!await supervisorDaemonClient.isMaintenanceHeld()) await supervisorGrantCoordinator.reconcileDesiredRunning().catch((error) => {
          console.warn(`Supervisor grant reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`);
        });
      } else {
        await startupPreparation;
      }
    })();
    // Rental recovery restores local deadlines promptly, then joins the startup
    // operation already registered by the application above.
    startRentalServices();
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
    if (process.platform === "darwin" && !app.isPackaged) {
      app.dock?.setIcon(join(workspaceRoot, "brand", "letagents-app-icon.png"));
    }
    configureApplicationMenu();
    createWindow();
    startWindowsSmokeNotification();
    void backgroundStartup;
    initializeDesktopUpdates();
    await initializeDesktopNotifications().catch((error) => {
      console.warn(`Desktop notification setup unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });

    app.on("activate", () => {
      if (!hasOpenWindows()) createWindow();
      focusMainWindow();
    });
  });

  autoUpdater.on("before-quit-for-update", allowMainWindowQuit);

  const lifecycleLog = letagentsHomePath("daemon-lifecycle.jsonl");
  app.on("render-process-gone", (_event, _contents, details) => recordDesktopExit(lifecycleLog, "desktop_renderer_gone", details.reason));
  app.on("child-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") recordDesktopExit(lifecycleLog, "desktop_child_gone", `${details.type}: ${details.reason}`);
  });

  app.on("before-quit", () => {
    recordDesktopExit(lifecycleLog, "desktop_quit");
    allowMainWindowQuit();
    setDesktopNotificationBadgeCount(0);
    stopDesktopUpdates();
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
}

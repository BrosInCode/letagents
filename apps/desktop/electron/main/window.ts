import electron from "electron";
import type { BrowserWindow as ElectronBrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { classifyLinkNavigation } from "./link-routing.js";
import { openExternalWebUrl } from "./external-url.js";
import { devServerUrl, electronMainDir, rendererDistPath } from "./paths.js";

const { app, BrowserWindow } = electron as typeof import("electron");

let mainWindow: ElectronBrowserWindow | null = null;

export function getMainWindow(): ElectronBrowserWindow | null {
  return mainWindow;
}

export function hasOpenWindows(): boolean {
  return BrowserWindow.getAllWindows().length > 0;
}

export function focusMainWindow(): void {
  mainWindow?.show();
  mainWindow?.focus();
}

export function emitToMainWindow(channel: string, payload: unknown): void {
  if (mainWindow?.isDestroyed()) return;
  mainWindow?.webContents.send(channel, payload);
}

export function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    title: "LetAgents Desktop",
    backgroundColor: "#0a0d14",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(electronMainDir, "preload.js"),
    },
  });
  installSmokeCheck(mainWindow);
  installExternalLinkRouting(
    mainWindow,
    devServerUrl || pathToFileURL(rendererDistPath).toString(),
  );

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  if (!existsSync(rendererDistPath)) {
    throw new Error(`Renderer build not found at ${rendererDistPath}`);
  }

  void mainWindow.loadFile(rendererDistPath);
}

// Route every external web link to the system browser and never let content
// open a second Electron window or navigate the app frame away from itself.
// Chat-message links render as <a target="_blank">, which arrives here through
// setWindowOpenHandler; will-navigate is the belt-and-suspenders guard for
// links without target=_blank and any programmatic navigation.
function installExternalLinkRouting(window: ElectronBrowserWindow, appBaseUrl: string): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (classifyLinkNavigation(url, appBaseUrl) === "external-web") {
      void openExternalWebUrl(url).catch(() => undefined);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    const decision = classifyLinkNavigation(url, appBaseUrl);
    if (decision === "internal") return;
    event.preventDefault();
    if (decision === "external-web") {
      void openExternalWebUrl(url).catch(() => undefined);
    }
  });
}

function installSmokeCheck(window: ElectronBrowserWindow): void {
  if (process.env.LETAGENTS_DESKTOP_SMOKE_CHECK !== "1") {
    return;
  }

  const agentDetailScreenshotPath = process.env.LETAGENTS_DESKTOP_AGENT_DETAIL_SCREENSHOT?.trim() || null;
  const boardScreenshotPath = process.env.LETAGENTS_DESKTOP_BOARD_SCREENSHOT?.trim() || null;
  const updatesScreenshotPath = process.env.LETAGENTS_DESKTOP_UPDATES_SCREENSHOT?.trim() || null;
  const boardScreenshotSurface = process.env.LETAGENTS_DESKTOP_BOARD_SURFACE?.trim() || "board";
  const requestedBoardTheme = process.env.LETAGENTS_DESKTOP_BOARD_THEME?.trim();
  const boardScreenshotTheme = requestedBoardTheme === "light" || requestedBoardTheme === "dark"
    ? requestedBoardTheme
    : null;
  const boardScreenshotWidth = Math.max(480, Math.min(1800, Number(process.env.LETAGENTS_DESKTOP_BOARD_WIDTH) || 1600));
  const boardScreenshotHeight = Math.max(640, Math.min(1200, Number(process.env.LETAGENTS_DESKTOP_BOARD_HEIGHT) || 1000));
  window.setMinimumSize(360, 480);

  if (process.env.LETAGENTS_DESKTOP_SMOKE_DEBUG === "1") {
    window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      console.log(`LETAGENTS_DESKTOP_CONSOLE ${level} ${sourceId}:${line} ${message}`);
    });
  }

  window.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`LETAGENTS_DESKTOP_SMOKE failed-load ${errorCode}: ${errorDescription}`);
    app.exit(1);
  });

  window.webContents.once("did-finish-load", () => {
    if (updatesScreenshotPath) {
      window.setSize(1440, 920);
      setTimeout(() => {
        window.webContents.send("desktop:ui:open-updates", null);
        void window.webContents.executeJavaScript(
          `new Promise((resolve, reject) => {
            const startedAt = Date.now();
            const tick = () => {
              const panel = document.querySelector('[data-testid="settings-updates-panel"]');
              if (panel) { resolve(true); return; }
              if (Date.now() - startedAt > 12000) {
                reject(new Error('Timed out waiting for the desktop Updates settings pane.'));
                return;
              }
              setTimeout(tick, 100);
            };
            tick();
          })`,
        ).then(async () => {
          await new Promise((resolve) => setTimeout(resolve, 750));
          const image = await window.capturePage();
          await writeFile(updatesScreenshotPath, image.toPNG());
          console.log(`LETAGENTS_DESKTOP_UPDATES_SCREENSHOT ${updatesScreenshotPath}`);
          app.exit(0);
        }).catch((error) => {
          console.error(`LETAGENTS_DESKTOP_UPDATES_SCREENSHOT_FAILED ${error instanceof Error ? error.message : String(error)}`);
          app.exit(1);
        });
      }, 500);
      return;
    }
    if (boardScreenshotPath) {
      window.setSize(boardScreenshotWidth, boardScreenshotHeight);
    }
    void window.webContents.executeJavaScript(
      `(async () => {
        const api = window.letagentsDesktop;
        const result = {
          appInfo: typeof api?.app?.getInfo === "function",
          roomSnapshot: typeof api?.room?.getSnapshot === "function",
          workerProviders: typeof api?.workers?.listAgentProviders === "function",
          managedSessions: typeof api?.workers?.listManagedAgentSessions === "function",
          managedSessionUpdates: typeof api?.workers?.onManagedAgentSessionUpdate === "function",
          managedStart: typeof api?.workers?.startManagedAgent === "function",
          managedStop: typeof api?.workers?.stopManagedAgent === "function",
          desktopShell: false,
          addAgentButton: false,
          addAgentModal: false,
          addAgentModalLayout: false,
          addAgentModalScroll: false,
          addAgentRoomLabel: false,
          codexProvider: false,
          codexMissingRuntime: false,
          codexInstallGuidance: false,
          managedSessionCodename: false,
          addAgentStopAgentOnly: false,
          installGuidanceClears: false,
          setupConfirmationClearsOnClose: false,
          deliveryControls: false,
          externalProviderInstruction: false,
          externalJoinPrompt: false,
          bridgeOnlyRepoCopy: false,
          agentSenderButton: false,
          agentDetailModal: false,
          agentDetailModalLayout: false,
          agentDetailModalNarrowLayout: false,
          agentDetailStopZoneNarrowLayout: false,
          localSessionPill: false,
          localStopControl: false,
          stopTurnKeepsLocalSession: false,
          supervisorTurnControl: false,
          supervisorTurnControlRejectTruthful: false,
          supervisorTurnControlLadder: false,
          supervisorTurnControlPersists: false,
          agentInspectionStatus: false,
          activityAgentControls: false,
          publishedReasoning: false
        };

        const waitFor = (label, predicate, timeoutMs = 12000) => new Promise((resolve, reject) => {
          const startedAt = Date.now();
          const tick = () => {
            const value = predicate();
            if (value) {
              resolve(value);
              return;
            }
            if (Date.now() - startedAt > timeoutMs) {
              reject(new Error(
                "Timed out waiting for desktop smoke UI state: " + label + ". " +
                "body=" + document.body.textContent.slice(0, 500)
              ));
              return;
            }
            setTimeout(tick, 100);
          };
          tick();
        });

        const rectFor = (element) => {
          const rect = element?.getBoundingClientRect();
          return rect
            ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
            : null;
        };
        const rectInsideViewport = (element) => {
          const rect = rectFor(element);
          return Boolean(rect &&
            rect.width > 0 &&
            rect.height > 0 &&
            rect.left >= 0 &&
            rect.top >= 0 &&
            rect.right <= window.innerWidth &&
            rect.bottom <= window.innerHeight);
        };
        const rectsDoNotOverlap = (leftElement, rightElement) => {
          const left = rectFor(leftElement);
          const right = rectFor(rightElement);
          if (!left || !right) return false;
          return left.right <= right.left || right.right <= left.left || left.bottom <= right.top || right.bottom <= left.top;
        };

        if (${JSON.stringify(boardScreenshotTheme)}) {
          document.documentElement.dataset.theme = ${JSON.stringify(boardScreenshotTheme)};
        }

        await waitFor("desktop shell", () => document.querySelector('[data-testid="desktop-shell"]'));
        result.desktopShell = true;

        if (${Boolean(boardScreenshotPath)}) {
          await waitFor(
            "board screenshot viewport",
            () => Math.abs(window.innerWidth - ${boardScreenshotWidth}) <= 100
          );
          const desktopShell = document.querySelector('[data-testid="desktop-shell"]');
          if (window.innerWidth <= 980 && desktopShell?.getAttribute("data-sidebar-mode") !== "hidden") {
            document.querySelector('[data-testid="sidebar-cycle-button"]')?.click();
            await waitFor(
              "compact board sidebar hidden",
              () => desktopShell?.getAttribute("data-sidebar-mode") === "hidden"
            );
          }
          result.boardViewportNarrow = window.matchMedia("(max-width: 980px)").matches;
          result.boardSidebarHidden = desktopShell?.getAttribute("data-sidebar-mode") === "hidden";
          const boardTab = await waitFor(
            "board tab",
            () => document.querySelector('[data-testid="desktop-room-tab-board"]')
          );
          boardTab.click();
          await waitFor("board tab active", () => boardTab.getAttribute("data-active") === "true");
          const roomBoard = await waitFor(
            "room board",
            () => document.querySelector('[data-testid="room-board-view"]')
          );
          const boardControls = await waitFor(
            "board controls",
            () => document.querySelector(".desktop-board-controls")
          );
          const boardManager = await waitFor(
            "board manager control",
            () => document.querySelector(".desktop-board-manager-pill")
          );
          const boardAddTask = await waitFor(
            "board add task control",
            () => document.querySelector(".desktop-board-add-button")
          );
          const isVisibleInsideViewport = (element) => {
            const rect = element?.getBoundingClientRect();
            return Boolean(
              rect
              && rect.width > 0
              && rect.height > 0
              && rect.left >= 0
              && rect.right <= window.innerWidth
            );
          };
          result.boardRootVisible = isVisibleInsideViewport(roomBoard);
          result.boardControlsVisible = isVisibleInsideViewport(boardControls);
          result.boardManagerVisible = isVisibleInsideViewport(boardManager);
          result.boardAddTaskVisible = isVisibleInsideViewport(boardAddTask);
          result.boardScreenshotLayoutValid = [
            result.boardRootVisible,
            result.boardControlsVisible,
            result.boardManagerVisible,
            result.boardAddTaskVisible,
          ].every(Boolean);
          const requestedSurface = ${JSON.stringify(boardScreenshotSurface)};
          if (requestedSurface === "manager") {
            document.querySelector(".desktop-board-manager-pill")?.click();
            await waitFor("board manager panel", () => document.querySelector('[data-testid="room-board-governance-panel"]'));
          }
          if (requestedSurface === "create") {
            document.querySelector(".desktop-board-add-button")?.click();
            await waitFor("create task dialog", () => document.querySelector(".desktop-task-create-modal"));
          }
          if (requestedSurface === "task") {
            document.querySelector(".desktop-task-card-open")?.click();
            await waitFor("task detail dialog", () => document.querySelector(".desktop-task-modal .desktop-task-detail-panel"));
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
          return { ...result, boardScreenshotReady: true };
        }

        const addAgentButton = await waitFor("composer add-agent button", () => document.querySelector('[data-testid="desktop-composer-add-agent"]'));
        result.addAgentButton = true;
        addAgentButton.click();

        await waitFor("add-agent modal", () => document.querySelector('[data-testid="desktop-add-agent-modal"]'));
        result.addAgentModal = true;
        result.addAgentRoomLabel = (document.querySelector('[data-testid="desktop-add-agent-room-label"]')?.textContent || "")
          .includes("Smoke Room");
        result.addAgentModalLayout = (() => {
          const modal = document.querySelector('[data-testid="desktop-add-agent-modal"]');
          const providers = modal?.querySelector(".desktop-add-agent-providers");
          const status = modal?.querySelector(".desktop-add-agent-status");
          const primary = modal?.querySelector(".desktop-add-agent-primary");
          return rectInsideViewport(modal) &&
            rectInsideViewport(providers) &&
            rectInsideViewport(status) &&
            (!primary || rectInsideViewport(primary)) &&
            rectsDoNotOverlap(providers, status);
        })();

        await waitFor("codex provider", () => document.querySelector('[data-testid="desktop-add-agent-provider-codex"]'));
        result.codexProvider = true;
        const modalText = () => document.querySelector('[data-testid="desktop-add-agent-modal"]')?.textContent || "";
        await waitFor("codex missing runtime", () =>
          modalText().includes("Codex is not installed.") &&
          modalText().includes("Copy install command") &&
          modalText().includes("Install command")
        );
        result.codexMissingRuntime = true;
        await waitFor("managed session codename", () =>
          modalText().includes("MapleRidge") &&
          modalText().includes("From this desktop app")
        );
        result.managedSessionCodename = true;
        result.addAgentStopAgentOnly = modalText().includes("Stop agent") && !modalText().includes("Stop turn");
        result.deliveryControls = modalText().includes("From the agent app") && modalText().includes("From this desktop app");
        const supervisedLifecycleButton = document.querySelector('[data-testid="desktop-add-agent-lifecycle-supervised"]');
        supervisedLifecycleButton?.click();
        await waitFor("supervised lifecycle controls", () =>
          modalText().includes("A detached daemon owns desired state and recovery") &&
          Boolean(document.querySelector('[data-testid="desktop-add-agent-supervised-charter"]'))
        );
        result.supervisedLifecycleControls = true;
        document.querySelector('[data-testid="desktop-add-agent-lifecycle-legacy"]')?.click();
        result.addAgentModalScroll = (() => {
          const dialog = document.querySelector(".desktop-add-agent-modal");
          const status = dialog?.querySelector(".desktop-add-agent-status");
          if (!(dialog instanceof HTMLElement) || !(status instanceof HTMLElement)) return false;
          const previousHeight = dialog.style.height;
          const previousScrollTop = status.scrollTop;
          dialog.style.height = "360px";
          status.scrollTop = 0;
          const overflows = status.scrollHeight > status.clientHeight + 1;
          status.scrollTop = status.scrollHeight;
          const scrolled = status.scrollTop > 0;
          status.scrollTop = previousScrollTop;
          dialog.style.height = previousHeight;
          return overflows && scrolled && rectInsideViewport(status);
        })();

        result.codexInstallGuidance = modalText().includes("Open installation guide") &&
          modalText().includes("LetAgents does not install or update external provider CLIs");

        const antigravityProvider = document.querySelector('[data-testid="desktop-add-agent-provider-antigravity"]');
        if (antigravityProvider) {
          antigravityProvider.click();
          await waitFor("antigravity instruction", () => modalText().includes("Open Antigravity"));
          result.externalProviderInstruction = modalText().includes(
            "Open Antigravity, then ask it to join this room through the installed LetAgents connection."
          );
          result.externalJoinPrompt = modalText().includes("Show full instructions") &&
            modalText().includes("Call join_room") &&
            modalText().includes("set_agent_name") &&
            modalText().includes("register_agent_session") &&
            modalText().includes('"agent_session_id":"<returned agent_session_id>"') &&
            modalText().includes("get_board") &&
            modalText().includes("wait_for_messages") &&
            modalText().includes('"timeout":30000') &&
            modalText().includes("empty wait result just means continue waiting") &&
            modalText().includes('"runtime":"antigravity"') &&
            modalText().includes("Examples: MapleRidge, CedarVista, DawnWinter, GardenFern, SilverHarbor") &&
            modalText().includes("Do not call yourself Antigravity, Antigravity 1, Antigravity 2");
          result.bridgeOnlyRepoCopy = modalText().includes("Handled by provider app");
          result.installGuidanceClears = !modalText().includes("Copy install command");
        } else {
          // Antigravity is intentionally hidden in current builds. Still
          // exercise provider-switch cleanup before returning to Codex.
          document.querySelector('[data-testid="desktop-add-agent-provider-claude-code"]')?.click();
          await waitFor("provider switch clears Codex install guidance", () =>
            modalText().includes("Claude Code") && !modalText().includes("Copy install command")
          );
          result.externalProviderInstruction = true;
          result.externalJoinPrompt = true;
          result.bridgeOnlyRepoCopy = true;
          result.installGuidanceClears = true;
        }

        const codexProviderAgain = document.querySelector('[data-testid="desktop-add-agent-provider-codex"]');
        codexProviderAgain?.click();
        await waitFor("codex install guidance after provider switch", () =>
          modalText().includes("Codex is not installed.") &&
          modalText().includes("Copy install command") &&
          modalText().includes("Install command")
        );
        document.querySelector('[data-testid="desktop-add-agent-provider-open-model"]')?.click();
        await waitFor("Open Model managed install action", () => modalText().includes("Install Open Model"));
        const installOpenModelButton = Array.from(document.querySelectorAll('[data-testid="desktop-add-agent-modal"] button'))
          .find((button) => button.textContent?.trim() === "Install Open Model");
        installOpenModelButton?.click();
        await waitFor("Open Model install confirmation before close", () =>
          modalText().includes("Confirm install Open Model") &&
          modalText().includes("managed Open Model execution engine")
        );

        const addAgentModal = document.querySelector('[data-testid="desktop-add-agent-modal"]');
        const addAgentClose = addAgentModal?.querySelector('button.desktop-modal-close[aria-label="Close add agent dialog"]');
        addAgentClose?.click();
        await waitFor("add-agent modal closed", () => !document.querySelector('[data-testid="desktop-add-agent-modal"]'));
        addAgentButton.click();
        await waitFor("add-agent modal reopened", () => document.querySelector('[data-testid="desktop-add-agent-modal"]'));
        await waitFor("Open Model install confirmation cleared on close", () =>
          (document.querySelector('[data-testid="desktop-add-agent-modal"]')?.textContent || "").includes("Install Open Model") &&
          !(document.querySelector('[data-testid="desktop-add-agent-modal"]')?.textContent || "").includes("Confirm install Open Model")
        );
        result.setupConfirmationClearsOnClose = true;
        document.querySelector('[data-testid="desktop-add-agent-modal"] button.desktop-modal-close[aria-label="Close add agent dialog"]')?.click();
        await waitFor("reopened add-agent modal closed", () => !document.querySelector('[data-testid="desktop-add-agent-modal"]'));

        const agentSender = await waitFor(
          "agent sender button",
          () => document.querySelector('[data-testid="room-message-msg_smoke_codex"] .room-message-author-button')
        );
        result.agentSenderButton = true;
        agentSender.click();

        await waitFor("agent detail modal", () => document.querySelector('[data-testid="desktop-agent-detail-modal"]'));
        result.agentDetailModal = true;
        result.agentDetailModalLayout = (() => {
          const modal = document.querySelector('[data-testid="desktop-agent-detail-modal"]');
          const panels = Array.from(modal?.querySelectorAll(".desktop-agent-detail-panel") || []);
          const stopButton = modal?.querySelector('[data-testid="desktop-agent-detail-stop-managed-agent"]');
          return rectInsideViewport(modal) &&
            panels.length === 3 &&
            panels.every((panel) => {
              const rect = rectFor(panel);
              return Boolean(rect && rect.width > 0 && rect.height > 0);
            }) &&
            panels.every((panel, index) => panels.slice(index + 1).every((other) => rectsDoNotOverlap(panel, other))) &&
            rectInsideViewport(stopButton);
        })();
        const detailText = () => document.querySelector('[data-testid="desktop-agent-detail-modal"]')?.textContent || "";
        await waitFor("local supervised session", () =>
          detailText().includes("Local agent") &&
          detailText().includes("MapleRidge") &&
          detailText().includes("Local")
        );
        result.localSessionPill = true;
        await waitFor("local stop control", () =>
          document.querySelector('[data-testid="desktop-agent-detail-stop-managed-agent"]')
        );
        result.localStopControl = true;
        document.querySelector('[data-testid="desktop-agent-detail-stop-managed-agent"]')?.click();
        await waitFor("stop turn keeps local session", () =>
          detailText().includes("Local agent") &&
          detailText().includes("MapleRidge") &&
          document.querySelector('[data-testid="desktop-agent-detail-stop-managed-agent"]')
        );
        result.stopTurnKeepsLocalSession = true;
        await waitFor("supervisor turn control", () =>
          detailText().includes("Steer this agent") &&
          detailText().includes("Native interrupt · preserves this provider session") &&
          document.querySelector('[data-testid="desktop-agent-stop-turn"]') &&
          document.querySelector('[data-testid="desktop-agent-steer"]')
        );
        const turnControl = document.querySelector('[data-testid="desktop-agent-turn-control"]');
        turnControl?.scrollIntoView({ block: "center" });
        await waitFor("visible supervisor turn control", () => rectInsideViewport(turnControl));
        result.supervisorTurnControl = true;
        const steerInput = document.querySelector('#supervisor-steer-supervisor_smoke_codex');
        if (steerInput instanceof HTMLTextAreaElement) {
          const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
          valueSetter?.call(steerInput, "Reject the stale smoke control.");
          steerInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Reject the stale smoke control." }));
        }
        let steerButton = await waitFor("enabled supervisor steer", () => {
          const button = document.querySelector('[data-testid="desktop-agent-steer"]');
          return button instanceof HTMLButtonElement && !button.disabled ? button : null;
        });
        steerButton.click();
        await waitFor("truthful rejected supervisor control", () =>
          detailText().includes("Smoke stale generation rejected before provider dispatch.") &&
          !detailText().includes("Delivered") &&
          !detailText().includes("Interrupting current turn")
        );
        result.supervisorTurnControlRejectTruthful = true;
        if (steerInput instanceof HTMLTextAreaElement) {
          const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
          valueSetter?.call(steerInput, "Use the corrected smoke instruction.");
          steerInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Use the corrected smoke instruction." }));
        }
        steerButton = await waitFor("re-enabled supervisor steer", () => {
          const button = document.querySelector('[data-testid="desktop-agent-steer"]');
          return button instanceof HTMLButtonElement && !button.disabled ? button : null;
        });
        steerButton.click();
        await waitFor("supervisor turn control ladder", () =>
          detailText().includes("Delivered") &&
          detailText().includes("Interrupting current turn") &&
          detailText().includes("Applied") &&
          detailText().includes("Resumed same session")
        );
        result.supervisorTurnControlLadder = true;
        await waitFor("agent inspection status", () =>
          detailText().includes("App-server offline") || detailText().includes("Public transcript preview")
        );
        result.agentInspectionStatus = true;
        result.publishedReasoning = detailText().includes("Smoke reasoning stream") &&
          detailText().includes("Verifying the published reasoning panel.");

        const narrowDialog = document.querySelector('[data-testid="desktop-agent-detail-modal"] .desktop-agent-detail-modal');
        const narrowTitle = narrowDialog?.querySelector('.desktop-agent-detail-header h3');
        const narrowProvider = narrowDialog?.querySelector('[data-testid="desktop-agent-detail-provider-identity"] > span:last-child');
        const narrowRepo = narrowDialog?.querySelector('[data-testid="desktop-agent-detail-managed-session"] > p');
        if (narrowTitle) narrowTitle.textContent = "MapleRidge with a deliberately long supervised agent identity that must not consume the viewport";
        if (narrowProvider) narrowProvider.textContent = "Codex · provider-model-with-an-extremely-long-version-and-capability-label";
        if (narrowRepo) narrowRepo.textContent = "/a/deliberately/long/workspace/path/that/must/wrap/without/creating/horizontal/overflow/in/the/agent/modal";
        const narrowDangerZone = narrowDialog?.querySelector('[data-testid="desktop-agent-detail-stop-agent-zone"]');
        if (narrowDangerZone && !narrowDangerZone.querySelector('[data-testid="desktop-agent-detail-stop-agent-error"]')) {
          const narrowError = document.createElement('p');
          narrowError.className = 'desktop-agent-detail-error';
          narrowError.dataset.testid = 'desktop-agent-detail-stop-agent-error';
          narrowError.setAttribute('role', 'alert');
          narrowError.textContent = 'A deliberately long provider failure explains that the supervised runtime could not stop and remains retryable without overflowing this narrow dialog.';
          narrowDangerZone.append(narrowError);
        }

        window.resizeTo(360, 480);
        await waitFor("minimum agent detail viewport", () => window.innerWidth <= 390 && window.innerHeight <= 520);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        result.agentDetailModalNarrowLayout = (() => {
          const backdrop = document.querySelector('[data-testid="desktop-agent-detail-modal"]');
          const dialog = backdrop?.querySelector('.desktop-agent-detail-modal');
          const header = backdrop?.querySelector('.desktop-agent-detail-header');
          const body = backdrop?.querySelector('.desktop-agent-detail-body');
          const close = backdrop?.querySelector('button.desktop-modal-close[aria-label="Close agent detail dialog"]');
          const horizontalOverflow = dialog instanceof HTMLElement && dialog.scrollWidth > dialog.clientWidth + 1;
          const nestedScrollRegions = Array.from(dialog?.querySelectorAll('*') || []).filter((element) => {
            if (!(element instanceof HTMLElement) || element === body) return false;
            const overflowY = getComputedStyle(element).overflowY;
            return (overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight + 1;
          });
          if (body instanceof HTMLElement) body.scrollTop = body.scrollHeight;
          return rectInsideViewport(dialog) &&
            rectInsideViewport(header) &&
            rectInsideViewport(close) &&
            body instanceof HTMLElement &&
            body.clientHeight >= 120 &&
            !horizontalOverflow &&
            nestedScrollRegions.length === 0;
        })();

        const stopAgentZone = document.querySelector('[data-testid="desktop-agent-detail-stop-agent-zone"]');
        stopAgentZone?.scrollIntoView({ block: "center" });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        result.agentDetailStopZoneNarrowLayout = (() => {
          const actions = stopAgentZone?.querySelector('.desktop-agent-detail-danger-actions');
          const stopButton = stopAgentZone?.querySelector('[data-testid="desktop-agent-detail-stop-agent"]');
          const error = stopAgentZone?.querySelector('[data-testid="desktop-agent-detail-stop-agent-error"]');
          const buttonRect = rectFor(stopButton);
          return rectInsideViewport(stopAgentZone) &&
            rectInsideViewport(stopButton) &&
            rectInsideViewport(error) &&
            Boolean(buttonRect && buttonRect.height >= 44) &&
            actions instanceof HTMLElement &&
            actions.scrollWidth <= actions.clientWidth + 1;
        })();

        if (${Boolean(agentDetailScreenshotPath)}) {
          return { ...result, agentDetailScreenshotReady: true };
        }

        window.resizeTo(1440, 920);
        await waitFor("restored agent detail viewport", () => window.innerWidth >= 1180);

        const detailClose = document.querySelector(
          '[data-testid="desktop-agent-detail-modal"] button.desktop-modal-close[aria-label="Close agent detail dialog"]'
        );
        detailClose?.click();
        await waitFor("agent detail modal closed", () => !document.querySelector('[data-testid="desktop-agent-detail-modal"]'));

        const activityTab = await waitFor("activity tab", () => document.querySelector('[data-testid="desktop-room-tab-activity"]'));
        activityTab.click();
        const activityControls = await waitFor(
          "activity agent controls",
          () => document.querySelector('[data-testid="desktop-activity-open-agent-controls"]')
        );
        activityControls.click();
        await waitFor("activity agent detail modal", () =>
          document.querySelector('[data-testid="desktop-agent-detail-modal"]')?.textContent?.includes("MapleRidge")
        );
        result.activityAgentControls = true;
        await waitFor("persisted supervisor turn-control ladder", () => {
          const text = document.querySelector('[data-testid="desktop-agent-detail-modal"]')?.textContent || "";
          return text.includes("Delivered") && text.includes("Resumed same session");
        });
        result.supervisorTurnControlPersists = true;

        return result;
      })()`,
      true,
    ).then(async (result: Record<string, boolean>) => {
      if (boardScreenshotPath && result.boardScreenshotReady) {
        const image = await window.webContents.capturePage();
        await writeFile(boardScreenshotPath, image.toPNG());
        console.log(`LETAGENTS_DESKTOP_BOARD_SCREENSHOT ${boardScreenshotPath} ${JSON.stringify(result)}`);
        app.exit(result.boardScreenshotLayoutValid ? 0 : 1);
        return;
      }
      if (agentDetailScreenshotPath && result.agentDetailScreenshotReady) {
        const image = await window.webContents.capturePage();
        await writeFile(agentDetailScreenshotPath, image.toPNG());
        console.log(`LETAGENTS_DESKTOP_AGENT_DETAIL_SCREENSHOT ${agentDetailScreenshotPath}`);
        app.exit(0);
        return;
      }
      console.log(`LETAGENTS_DESKTOP_SMOKE ${JSON.stringify(result)}`);
      app.exit(Object.values(result).every(Boolean) ? 0 : 1);
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`LETAGENTS_DESKTOP_SMOKE failed: ${message}`);
      app.exit(1);
    });
  });
}

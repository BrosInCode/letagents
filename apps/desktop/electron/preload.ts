import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "./ipc-types.js";

const api: DesktopApi = {
  app: {
    getInfo: () => ipcRenderer.invoke("desktop:app:get-info"),
  },
  room: {
    getSnapshot: (roomIdentifier?: string | null) => ipcRenderer.invoke("desktop:room:get-snapshot", roomIdentifier ?? null),
    sendMessage: (roomIdentifier: string, text: string) =>
      ipcRenderer.invoke("desktop:room:send-message", roomIdentifier, text),
  },
  auth: {
    getStatus: () => ipcRenderer.invoke("desktop:auth:get-status"),
    startDeviceFlow: (roomIdentifier?: string | null) =>
      ipcRenderer.invoke("desktop:auth:start-device-flow", roomIdentifier ?? null),
    pollDeviceFlow: (requestId?: string | null) =>
      ipcRenderer.invoke("desktop:auth:poll-device-flow", requestId ?? null),
    openVerification: (url: string) => ipcRenderer.invoke("desktop:auth:open-verification", url),
    signOut: () => ipcRenderer.invoke("desktop:auth:sign-out"),
  },
  setup: {
    getMcpInstallState: () => ipcRenderer.invoke("desktop:setup:get-mcp-install-state"),
    installMcpServer: (targetId) => ipcRenderer.invoke("desktop:setup:install-mcp-server", targetId),
    installMcpServers: (targetIds) => ipcRenderer.invoke("desktop:setup:install-mcp-servers", [...targetIds]),
    completeMcpOnboarding: () => ipcRenderer.invoke("desktop:setup:complete-mcp-onboarding"),
  },
  repos: {
    getStatus: () => ipcRenderer.invoke("desktop:repos:get-status"),
    pickRoom: () => ipcRenderer.invoke("desktop:repos:pick-room"),
  },
  workers: {
    list: () => ipcRenderer.invoke("desktop:workers:list"),
  },
  diagnostics: {
    getSnapshot: () => ipcRenderer.invoke("desktop:diagnostics:get-snapshot"),
  },
};

contextBridge.exposeInMainWorld("letagentsDesktop", api);

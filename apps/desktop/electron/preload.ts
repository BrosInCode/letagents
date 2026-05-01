import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "./ipc-types.js";

const api: DesktopApi = {
  app: {
    getInfo: () => ipcRenderer.invoke("desktop:app:get-info"),
  },
  room: {
    getSnapshot: (roomIdentifier?: string | null) => ipcRenderer.invoke("desktop:room:get-snapshot", roomIdentifier ?? null),
  },
  repos: {
    getStatus: () => ipcRenderer.invoke("desktop:repos:get-status"),
  },
  workers: {
    list: () => ipcRenderer.invoke("desktop:workers:list"),
  },
  diagnostics: {
    getSnapshot: () => ipcRenderer.invoke("desktop:diagnostics:get-snapshot"),
  },
};

contextBridge.exposeInMainWorld("letagentsDesktop", api);

import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "./ipc-types.js";

const api: DesktopApi = {
  app: {
    getInfo: () => ipcRenderer.invoke("desktop:app:get-info"),
  },
  room: {
    getSnapshot: (roomIdentifier?: string | null) => ipcRenderer.invoke("desktop:room:get-snapshot", roomIdentifier ?? null),
    getMessagesBefore: (roomIdentifier: string, beforeMessageId: string, limit?: number) =>
      ipcRenderer.invoke("desktop:room:get-messages-before", roomIdentifier, beforeMessageId, limit ?? 150),
    getReasoningSession: (roomIdentifier: string, sessionId: string) =>
      ipcRenderer.invoke("desktop:room:get-reasoning-session", roomIdentifier, sessionId),
    pickAttachments: (roomIdentifier: string) => ipcRenderer.invoke("desktop:room:pick-attachments", roomIdentifier),
    stageDroppedAttachmentContents: (roomIdentifier, files) =>
      ipcRenderer.invoke("desktop:room:stage-dropped-attachment-contents", roomIdentifier, files),
    discardAttachment: (roomIdentifier: string, uploadId: string) =>
      ipcRenderer.invoke("desktop:room:discard-attachment", roomIdentifier, uploadId),
    startStream: (roomIdentifier: string, afterMessageId?: string | null) =>
      ipcRenderer.invoke("desktop:room:start-stream", roomIdentifier, afterMessageId ?? null),
    stopStream: (roomIdentifier?: string | null) => ipcRenderer.invoke("desktop:room:stop-stream", roomIdentifier ?? null),
    onStreamEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload);
      ipcRenderer.on("desktop:room:stream-event", listener);
      return () => {
        ipcRenderer.off("desktop:room:stream-event", listener);
      };
    },
    sendMessage: (roomIdentifier: string, text: string, replyTo?: string | null, attachments?: Array<{ upload_id: string }>) =>
      ipcRenderer.invoke("desktop:room:send-message", roomIdentifier, text, replyTo ?? null, attachments ?? []),
    addTask: (roomIdentifier: string, title: string) =>
      ipcRenderer.invoke("desktop:room:add-task", roomIdentifier, title),
    updateTask: (roomIdentifier: string, taskId: string, updates) =>
      ipcRenderer.invoke("desktop:room:update-task", roomIdentifier, taskId, updates),
    updateTaskLease: (roomIdentifier: string, taskId: string, input) =>
      ipcRenderer.invoke("desktop:room:update-task-lease", roomIdentifier, taskId, input),
    updateTaskReviewLease: (roomIdentifier: string, taskId: string, input) =>
      ipcRenderer.invoke("desktop:room:update-task-review-lease", roomIdentifier, taskId, input),
    runTaskWorkerAction: (roomIdentifier: string, taskId: string, input) =>
      ipcRenderer.invoke("desktop:room:run-task-worker-action", roomIdentifier, taskId, input),
    runTaskReviewWorkerAction: (roomIdentifier: string, taskId: string, input) =>
      ipcRenderer.invoke("desktop:room:run-task-review-worker-action", roomIdentifier, taskId, input),
    rename: (roomIdentifier: string, displayName: string) =>
      ipcRenderer.invoke("desktop:room:rename", roomIdentifier, displayName),
    createInviteRoom: () => ipcRenderer.invoke("desktop:room:create-invite-room"),
    getGitHubIntegrationStatus: (roomIdentifier: string) =>
      ipcRenderer.invoke("desktop:room:get-github-integration-status", roomIdentifier),
    openGitHubInstall: (roomIdentifier: string) =>
      ipcRenderer.invoke("desktop:room:open-github-install", roomIdentifier),
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

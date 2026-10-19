import {
  discardCloudMessageAttachment,
  stageCloudMessageAttachment,
  type MessageAttachmentTransport,
} from "../../../../../shared/message-attachments.mjs";
import { apiFetch } from "../auth.js";
import { stagedAttachment, type AttachmentStore } from "./store.js";

const desktopApiTransport: MessageAttachmentTransport = {
  requestJson: (path, init) => apiFetch<unknown>(path, init),
};

export function createCloudAttachmentStore(
  roomIdentifier: string,
  transport: MessageAttachmentTransport = desktopApiTransport,
): AttachmentStore {
  const roomPath = `/rooms/${encodeURIComponent(roomIdentifier)}`;
  return {
    kind: "cloud",
    roomIdentifier,
    async stage(file) {
      const staged = await stageCloudMessageAttachment(transport, {
        roomPath,
        fileName: file.fileName,
        mimeType: file.mimeType,
        bytes: file.bytes,
      });
      return stagedAttachment(file, staged.uploadId);
    },
    async discard(uploadId) {
      await discardCloudMessageAttachment(transport, { roomPath, uploadId });
    },
  };
}

export declare const MESSAGE_ATTACHMENT_LIMITS: Readonly<{
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}>;

export declare function guessMessageAttachmentMimeType(fileName: string): string;
export declare function formatMessageAttachmentLimit(bytes: number): string;
export declare function assertMessageAttachmentFits(fileName: string, byteSize: number): void;

/** How a process reaches the room API. It owns the base URL and the credential. */
export interface MessageAttachmentTransport {
  requestJson(path: string, init: { method: "POST" | "DELETE"; headers?: Record<string, string>; body?: string }): Promise<unknown>;
  /** The storage upload is a presigned URL, so it uses a plain fetch without room credentials. */
  fetch?: typeof fetch;
}

export interface MessageAttachmentUploadTarget {
  uploadId: string;
  uploadUrl: string;
  headers: Record<string, string>;
}

export declare function parseMessageAttachmentUploadTarget(value: unknown): MessageAttachmentUploadTarget;

export interface StagedCloudMessageAttachment {
  uploadId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export declare function stageCloudMessageAttachment(
  transport: MessageAttachmentTransport,
  input: { roomPath: string; fileName: string; mimeType: string; bytes: Uint8Array },
): Promise<StagedCloudMessageAttachment>;

export declare function discardCloudMessageAttachment(
  transport: MessageAttachmentTransport,
  input: { roomPath: string; uploadId: string },
): Promise<void>;

export declare function validReplyAttachmentsRequest(value: unknown): value is { files: string[] | null };

export interface RecordedReplyAttachment {
  spool_id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
}

export declare function validRecordedReplyAttachments(value: unknown): value is { files: RecordedReplyAttachment[] | null };

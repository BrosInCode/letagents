export type AttachmentImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export function sniffAttachmentImageType(bytes: Uint8Array): AttachmentImageMimeType | null;
export function detectAttachmentFile(bytes: Uint8Array):
  | { kind: "empty" } | { kind: "binary" } | { kind: "pdf" }
  | { kind: "text"; bytes: Uint8Array; encoding: "utf-8" | "utf-16" | "unknown"; lines: number; longestLine: number };

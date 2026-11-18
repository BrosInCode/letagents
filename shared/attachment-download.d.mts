export const ATTACHMENT_REDIRECT_STATUSES: ReadonlySet<number>;
export class AttachmentDownloadError extends Error {
  constructor(reason: "too_large" | "unavailable");
  readonly reason: "too_large" | "unavailable";
}
export function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array>;
export function isThisMachineAddress(address: string): boolean;
export function namesThisMachine(hostname: string): boolean;
export function isLoopbackApiUrl(apiUrl: string): boolean;
export function attachmentStorageUrl(location: string | null, apiUrl: string): URL;
export function storageResolvesToThisMachine(hostname: string, signal: AbortSignal,
  resolve?: (hostname: string) => Promise<Array<{ address: string }>>): Promise<boolean>;

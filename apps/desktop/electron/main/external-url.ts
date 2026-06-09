import { shell } from "electron";

export function assertAllowedExternalUrl(rawUrl: string, allowedHosts: readonly string[]): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("External URL is invalid.");
  }
  if (url.protocol !== "https:") {
    throw new Error("External URL must use https.");
  }
  const hostname = url.hostname.toLowerCase();
  const allowed = allowedHosts.some((host) => hostname === host.toLowerCase());
  if (!allowed) {
    throw new Error("External URL host is not allowed.");
  }
  return url.toString();
}

export async function openAllowedExternalUrl(rawUrl: string, allowedHosts: readonly string[]): Promise<void> {
  await shell.openExternal(assertAllowedExternalUrl(rawUrl, allowedHosts));
}


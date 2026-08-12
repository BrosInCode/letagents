import electron from "electron";

const { shell } = electron as typeof import("electron");

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

// Validates an arbitrary web URL for opening in the system browser. Unlike
// assertAllowedExternalUrl this allows any host (user-authored chat links are
// not on a fixed allowlist), but still restricts the scheme to http/https so a
// crafted link cannot drive shell.openExternal into file:, mailto:, or a
// custom protocol handler.
export function assertExternalWebUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("External URL is invalid.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("External URL must use http or https.");
  }
  return url.toString();
}

export async function openExternalWebUrl(rawUrl: string): Promise<void> {
  await shell.openExternal(assertExternalWebUrl(rawUrl));
}

// Pure navigation-routing policy for the main window, factored out of window.ts
// so it can be unit-tested without Electron. Given a navigation target and the
// URL the app itself was loaded from, decide whether the navigation is the
// app navigating within itself, an external web link that should open in the
// system browser, or something to block outright.

export type LinkNavigationDecision = "internal" | "external-web" | "block";

export function classifyLinkNavigation(
  targetUrl: string,
  appBaseUrl: string | null,
): LinkNavigationDecision {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return "block";
  }

  const base = parseUrl(appBaseUrl);
  if (base && isInternalNavigation(target, base)) {
    return "internal";
  }

  if (target.protocol === "http:" || target.protocol === "https:") {
    return "external-web";
  }

  return "block";
}

function isInternalNavigation(target: URL, base: URL): boolean {
  // Packaged builds load the renderer from a file: URL. Treat only files under
  // the renderer directory as internal, so a content link like file:///etc/...
  // is never mistaken for an in-app navigation.
  if (base.protocol === "file:") {
    if (target.protocol !== "file:") return false;
    const baseDir = base.pathname.replace(/[^/]*$/, "");
    return target.pathname.startsWith(baseDir);
  }
  // Dev builds load from the Vite dev server; same-origin navigations (e.g. an
  // HMR full reload) are internal.
  return target.origin === base.origin;
}

function parseUrl(rawUrl: string | null): URL | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

/**
 * Display helpers for paths on this computer. They accept POSIX paths and the
 * Windows forms (`\` or `/` separators, `C:\` drive roots and `\\server\share`
 * UNC roots), whatever platform the renderer runs on. Room identifiers and
 * URLs are not local paths and must not go through these helpers.
 */

/** The root a path starts with: "/", "C:\", "C:", "\\server\share\" or "". */
function localPathRoot(path: string): string {
  const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.exec(path);
  if (unc) return unc[0];
  const drive = /^[A-Za-z]:(?:[\\/]|$)/.exec(path);
  if (drive) return drive[0];
  return /^[\\/]/.test(path) ? path[0]! : "";
}

/** The last segment of a local path, or "" for a root or an empty path. */
export function localPathBasename(path: string | null | undefined): string {
  const value = path?.trim() ?? "";
  const rest = value.slice(localPathRoot(value).length);
  return rest.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

/**
 * The folder that holds a local path, keeping the path's own separators, or ""
 * when the path has no parent (a root or a bare name).
 */
export function localPathDirname(path: string | null | undefined): string {
  const value = path?.trim() ?? "";
  const root = localPathRoot(value);
  const rest = value.slice(root.length).replace(/[\\/]+$/, "");
  const cut = Math.max(rest.lastIndexOf("/"), rest.lastIndexOf("\\"));
  if (cut < 0) return rest && root ? root : "";
  return root + rest.slice(0, cut).replace(/[\\/]+$/, "");
}

/** True for the platform strings of Windows: Electron's "win32" and the browser's "Win32". */
export function isWindowsPlatform(platform?: string | null): boolean {
  const resolved = platform ?? (typeof navigator !== "undefined" ? navigator.platform : "");
  return /^win/i.test(resolved);
}

/** Example paths for inputs and hints, in the form this platform uses. */
export function localPathExamples(platform?: string | null): { parent: string; project: string } {
  return isWindowsPlatform(platform)
    ? { parent: "C:\\Users\\you\\Projects", project: "C:\\Users\\you\\code\\my-project" }
    : { parent: "~/Projects", project: "~/code/my-project" };
}

/** Joins a folder and a name with the separator the folder already uses; a bare folder name uses the platform's. */
export function joinLocalPath(folder: string, name: string, platform?: string | null): string {
  const base = folder.trim().replace(/[\\/]+$/, "");
  const separator = base.includes("\\") ? "\\"
    : base.includes("/") ? "/"
      : /^[A-Za-z]:$/.test(base) || isWindowsPlatform(platform) ? "\\" : "/";
  return `${base}${separator}${name}`;
}

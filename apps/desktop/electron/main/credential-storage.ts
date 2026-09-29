import electron from "electron";

type CredentialStorageShell = Pick<typeof import("electron").shell, "openPath">;

const { shell } = electron as typeof import("electron");

export const MACOS_KEYCHAIN_ACCESS_PATHS = [
  "/System/Library/CoreServices/Applications/Keychain Access.app",
  "/System/Applications/Utilities/Keychain Access.app",
  "/Applications/Utilities/Keychain Access.app",
] as const;

/**
 * Opens the OS credential manager without collecting a user's login password
 * or weakening the encrypted-at-rest supervisor-grant boundary.
 */
export async function openDesktopCredentialStorage(options: {
  platform?: NodeJS.Platform;
  shell?: CredentialStorageShell;
} = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error("Credential-storage recovery is only available on macOS.");
  }

  const targetShell = options.shell ?? shell;
  const failures: string[] = [];
  for (const path of MACOS_KEYCHAIN_ACCESS_PATHS) {
    const error = await targetShell.openPath(path);
    if (!error) return;
    failures.push(error);
  }
  throw new Error(failures.at(-1) || "Keychain Access could not be opened.");
}

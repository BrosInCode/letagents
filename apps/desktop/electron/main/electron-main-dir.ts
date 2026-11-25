import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The folder of the Electron code: electron in the source, dist-electron in
// the build and in the packaged app. The preload scripts are in this folder.
// The value depends on the place of this file, so the file stays in
// electron/main.
export const electronMainDir = join(dirname(fileURLToPath(import.meta.url)), "..");

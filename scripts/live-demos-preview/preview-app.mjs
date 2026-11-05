// "LetAgents Preview": this branch's desktop app, pointed at https://x.letagents.chat.
// It runs the real compiled main, preload and renderer from ./.build, but stays apart
// from an installed LetAgents app:
//   - HOME and the app data are ./.home (inside this folder);
//   - safeStorage is replaced by a local encoding (the seam the repo's auth tests use),
//     so the OS keychain is never read or written; the preview sign-in stays in ./.home;
//   - agents and the supervisor daemon are off, so nothing competes with an installed
//     app's daemon;
//   - no single-instance lock, letagents:// link registration, notifications or updates.
import electron from "electron";
import { Buffer } from "node:buffer";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { app, protocol, safeStorage } = electron;
const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, ".build/apps/desktop/dist-electron");
const USER_DATA = process.env.LETAGENTS_DESKTOP_USER_DATA_DIR || "";
const fail = (message) => { console.error(`[preview] ${message}`); process.exit(3); };
if (!(process.env.HOME || "").startsWith(join(HERE, ".home"))) fail("run this with start.sh");
if (!USER_DATA.startsWith(join(HERE, ".home"))) fail("run this with start.sh");
if (process.env.LETAGENTS_API_URL !== "https://x.letagents.chat") fail("LETAGENTS_API_URL must be https://x.letagents.chat");

const localSecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`preview:${value}`, "utf8"),
  decryptString: (value) => {
    const text = Buffer.from(value).toString("utf8");
    if (!text.startsWith("preview:")) throw new Error("not a preview value");
    return text.slice("preview:".length);
  },
  getSelectedStorageBackend: () => "preview_local",
  setUsePlainTextEncryption: () => undefined,
};
for (const [key, value] of Object.entries(localSecretStorage)) {
  try { safeStorage[key] = value; } catch { /* checked below */ }
}
if (["isEncryptionAvailable", "encryptString", "decryptString"].some((key) => safeStorage[key] !== localSecretStorage[key])) {
  fail("could not replace safeStorage; refusing to start (the real one would use the keychain)");
}
mkdirSync(USER_DATA, { recursive: true, mode: 0o700 });
app.setName("LetAgents Preview");
app.setPath("userData", USER_DATA);
app.commandLine.appendSwitch("use-mock-keychain");

const paths = await import(pathToFileURL(join(DIST, "main/paths.js")).href);
protocol.registerSchemesAsPrivileged([
  { scheme: paths.attachmentProtocolScheme, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: paths.htmlDemoProtocolScheme, privileges: { standard: true, secure: true } },
]);
const caps = await import(pathToFileURL(join(DIST, "main/platform-capabilities.js")).href);
caps.setDesktopPlatformCapabilitiesForTest({ supervisedAgentsSupported: false, supervisorDaemonAllowed: false });

const { registerDesktopIpcHandlers } = await import(pathToFileURL(join(DIST, "main/ipc.js")).href);
const { handleAttachmentProtocolRequest } = await import(pathToFileURL(join(DIST, "main/attachments.js")).href);
const windowMod = await import(pathToFileURL(join(DIST, "main/window.js")).href);
registerDesktopIpcHandlers();
app.on("window-all-closed", () => app.quit());

app.whenReady().then(() => {
  protocol.handle(paths.attachmentProtocolScheme, handleAttachmentProtocolRequest);
  windowMod.createWindow();
  const win = windowMod.getMainWindow();
  win.setTitle("LetAgents Preview · x.letagents.chat");
  win.on("page-title-updated", (event) => event.preventDefault());
}).catch((error) => fail(error?.stack || String(error)));

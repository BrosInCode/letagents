const { lstatSync, mkdirSync, realpathSync } = require("node:fs");
const { userInfo } = require("node:os");
const { join } = require("node:path");

const PREVIEW_PROFILE = Object.freeze({
  id: "agent-room-refresh",
  productName: "LetAgents Preview",
  bundleIdentifier: "chat.letagents.desktop.preview",
  protocol: "letagents-preview",
});
const PREVIEW_MARKER = Symbol.for("letagents.isolated-desktop-preview");

function desktopArtifactProfile({ preview = false, platform = process.platform } = {}) {
  if (preview && platform !== "darwin") throw new Error("The isolated preview currently supports macOS only.");
  return preview ? {
    ...PREVIEW_PROFILE,
    releaseDirectory: "LetAgents-Preview-darwin",
    bundle: "LetAgents Preview.app",
    main: "preview-bootstrap.mjs",
    updater: false,
  } : {
    productName: "LetAgents",
    bundleIdentifier: "chat.letagents.desktop",
    protocol: "letagents",
    releaseDirectory: platform === "win32" ? "LetAgents-win32" : "LetAgents-darwin",
    bundle: platform === "win32" ? "LetAgents" : "LetAgents.app",
    updater: true,
  };
}

// The preview owns these directories. Refuse links instead of following a path
// that could send state writes into the installed app's directories.
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`The preview state directory must be a real directory: ${path}`);
  }
  return path;
}

/** Run before importing any desktop module: several create stores on import. */
function configureIsolatedPreview({ app, profile, env = process.env, realHome = userInfo().homedir, globalObject = globalThis, changeDirectory = process.chdir }) {
  if (!app.isPackaged || profile?.id !== PREVIEW_PROFILE.id
    || profile?.bundleIdentifier !== PREVIEW_PROFILE.bundleIdentifier) {
    throw new Error("The preview bootstrap requires an explicitly packaged preview profile.");
  }
  const root = join(realpathSync(realHome), ".letagents-preview");
  const home = join(root, "home");
  if (Buffer.byteLength(join(home, ".letagents", "daemon.sock")) >= 104) {
    throw new Error("The preview home path is too long for the macOS daemon socket.");
  }
  const paths = {
    home,
    appData: join(root, "app-data"),
    userData: join(root, "user-data"),
    sessionData: join(root, "session-data"),
    logs: join(root, "logs"),
    crashDumps: join(root, "crash-dumps"),
    temp: join(root, "tmp"),
  };
  privateDirectory(root);
  for (const path of Object.values(paths)) privateDirectory(path);
  for (const child of [".letagents", ".codex", ".claude", ".config", ".cache", ".local", ".local/share"]) {
    privateDirectory(join(home, child));
  }

  // Keep executable discovery, not inherited credentials, path overrides,
  // provider sessions, NODE_OPTIONS, or shell startup configuration.
  const inheritedPath = env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
  const allowed = /^(PATH|SHELL|LANG|LC_[A-Z_]+|TZ|USER|LOGNAME|TERM|COLORTERM|DISPLAY|SECURITYSESSIONID|XPC_SERVICE_NAME|__CFBundleIdentifier)$/;
  for (const key of Object.keys(env)) if (!allowed.test(key)) delete env[key];
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: paths.temp,
    TMP: paths.temp,
    TEMP: paths.temp,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    __CFBundleIdentifier: PREVIEW_PROFILE.bundleIdentifier,
    PATH: [...new Set([
      ...inheritedPath.split(":"), join(realHome, ".local", "bin"),
      join(realHome, ".bun", "bin"), join(realHome, ".volta", "bin"),
      "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
    ].filter(Boolean))].join(":"),
  });
  for (const name of ["user-data-dir", "disk-cache-dir", "log-file", "crash-dumps-dir"]) app.commandLine?.removeSwitch(name);
  for (const [name, path] of Object.entries(paths)) app.setPath(name, path);
  app.setName(PREVIEW_PROFILE.productName);
  changeDirectory(home);
  Object.defineProperty(globalObject, PREVIEW_MARKER, { value: PREVIEW_PROFILE.id, writable: false, configurable: false });
  return { root, ...paths };
}

module.exports = { PREVIEW_PROFILE, PREVIEW_MARKER, desktopArtifactProfile, configureIsolatedPreview };

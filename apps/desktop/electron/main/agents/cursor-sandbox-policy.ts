import { chmodSync, existsSync, lstatSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function isExactCursorLoopbackTestOrigin(value: string): boolean {
  const match = /^http:\/\/127[.]0[.]0[.]1:([1-9][0-9]{0,4})$/.exec(value);
  if (!match) return false;
  const port = Number(match[1]);
  return Number.isSafeInteger(port) && port <= 65_535;
}

let cachedCursorSandboxDelegatingExecutablePaths: string[] | null = null;

export function cursorSandboxDeveloperRoots(): string[] {
  if (process.platform !== "darwin") return [];
  const roots: string[] = [];
  try {
    const selected = readlinkSync("/var/db/xcode_select_link");
    roots.push(isAbsolute(selected) ? selected : resolve("/var/db", selected));
  } catch {}
  roots.push(
    "/Library/Developer/CommandLineTools",
    "/Applications/Xcode.app/Contents/Developer",
  );
  return [...new Set(roots)].filter((root) => existsSync(root));
}

export function cursorSandboxToolchainBinPaths(): string[] {
  return cursorSandboxDeveloperRoots().flatMap((developerRoot) => [
    join(developerRoot, "Toolchains", "XcodeDefault.xctoolchain", "usr", "bin"),
    join(developerRoot, "usr", "bin"),
  ]).filter((directory) => existsSync(directory));
}

export function cursorSandboxSdkRoot(): string | null {
  for (const developerRoot of cursorSandboxDeveloperRoots()) {
    for (const sdkRoot of [
      join(developerRoot, "SDKs", "MacOSX.sdk"),
      join(developerRoot, "Platforms", "MacOSX.platform", "Developer", "SDKs", "MacOSX.sdk"),
    ]) {
      if (existsSync(sdkRoot)) return sdkRoot;
    }
  }
  return null;
}

export function cursorSandboxPathWithToolchains(pathValue: string, toolchainPaths: readonly string[]): string {
  const entries = pathValue.split(delimiter).filter(Boolean);
  const insertionIndex = entries.indexOf("/usr/bin");
  entries.splice(insertionIndex >= 0 ? insertionIndex : entries.length, 0, ...toolchainPaths);
  return [...new Set(entries)].join(delimiter);
}

export function cursorSandboxDelegatingExecutablePaths(): string[] {
  if (cachedCursorSandboxDelegatingExecutablePaths) {
    return [...cachedCursorSandboxDelegatingExecutablePaths];
  }
  const paths = new Set([
    "/bin/launchctl", "/bin/kill",
    "/usr/bin/afplay", "/usr/bin/automator", "/usr/bin/defaults", "/usr/bin/hdiutil", "/usr/bin/killall",
    "/usr/bin/instruments", "/usr/bin/mdfind", "/usr/bin/mdls", "/usr/bin/open", "/usr/bin/osascript",
    "/usr/bin/pbcopy", "/usr/bin/pbpaste", "/usr/bin/qlmanage", "/usr/bin/say",
    "/usr/bin/screencapture", "/usr/bin/security", "/usr/bin/shortcuts", "/usr/bin/xcrun",
    "/usr/sbin/diskutil", "/usr/sbin/networksetup", "/usr/sbin/scutil",
  ]);
  if (process.platform === "darwin") {
    // Resolve selected Developer tool paths without spawning a process on
    // Electron's main thread, then deny effect-delegating binaries directly
    // as well as xcrun above. Repo builds can invoke compilers directly.
    for (const developerRoot of cursorSandboxDeveloperRoots()) {
      for (const relativePath of [
        "usr/bin/simctl",
        "usr/bin/devicectl",
        "usr/bin/xctrace",
        "usr/bin/xcdevice",
        "usr/bin/notarytool",
        "usr/bin/altool",
        "usr/bin/stapler",
      ]) {
        const executable = join(developerRoot, relativePath);
        if (!existsSync(executable)) continue;
        paths.add(executable);
        try { paths.add(realpathSync(executable)); } catch {}
      }
    }
  }
  cachedCursorSandboxDelegatingExecutablePaths = [...paths];
  return [...cachedCursorSandboxDelegatingExecutablePaths];
}

export function validateCursorSandboxPaths(paths: string[] | undefined): string[] {
  if (!paths) return [];
  if (paths.length > 512) throw new Error("Cursor native sandbox has too many authority paths.");
  return [...new Set(paths.map((path) => {
    if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path, "utf8") > 4_096) {
      throw new Error("Cursor native sandbox authority paths must be bounded and absolute.");
    }
    return path;
  }))];
}

export function cursorSandboxRuntimeReadSubpaths(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const resolveExecutable = (entry: string): { logical: string; canonical: string }[] => {
    const candidates = isAbsolute(entry) || entry.includes("/")
      ? [resolve(cwd, entry)]
      : (env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => resolve(directory, entry));
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      try {
        return [{ logical: candidate, canonical: realpathSync(candidate) }];
      } catch {
        // Continue to another exact PATH candidate without invoking a shell.
      }
    }
    return [];
  };
  const appRoot = (executable: string): string | null => {
    let current = dirname(executable);
    for (;;) {
      if (current.endsWith(".app")) return current;
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  };
  const commandExecutables = resolveExecutable(command);
  const hostExecutables = resolveExecutable(process.execPath);
  const commandRuntimeRoots = commandExecutables.flatMap(({ canonical }) => {
    const applicationRoot = appRoot(canonical);
    if (applicationRoot) return [applicationRoot];
    const cursorInstall = /^(.*\/[.]local\/share\/cursor-agent\/versions\/[^/]+)\/cursor-agent$/.exec(canonical);
    return cursorInstall ? [cursorInstall[1]] : [];
  });
  const hostAppRoots = hostExecutables.flatMap(({ canonical }) => {
    const root = appRoot(canonical);
    return root ? [root] : [];
  });
  const pathDirectories = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => resolve(cwd, directory))
    .flatMap((logical) => {
      if (!existsSync(logical)) return [];
      try { return [{ logical, canonical: realpathSync(logical) }]; }
      catch { return []; }
    });
  let canonicalHostHome = resolve(homedir());
  try { canonicalHostHome = realpathSync(canonicalHostHome); } catch {}
  const isSameOrAncestor = (root: string, candidate: string): boolean => {
    const suffix = relative(root, candidate);
    return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
  };
  const toolchainRoots = pathDirectories.flatMap(({ logical, canonical }) => {
    const roots: string[] = [];
    const executableDirectoryName = /^(?:bin|sbin|shims|[A-Za-z0-9._-]+[-_.]bin)$/i;
    if (executableDirectoryName.test(basename(logical))
      && executableDirectoryName.test(basename(canonical))
      && canonical !== "/"
      && !isSameOrAncestor(canonical, canonicalHostHome)) {
      // A PATH directory is an executable capability, but only conventional,
      // narrow bin/shim directories are readable. Resolve the pair together:
      // a harmless-looking alias must not smuggle HOME, one of its private
      // child directories, or / into the fence.
      roots.push(logical, canonical);
    }
    const versionedBinPatterns = [
      /^(.*\/[.]nvm\/versions\/node\/[^/]+)\/bin$/,
      /^(.*\/[.]fnm\/node-versions\/[^/]+\/installation)\/bin$/,
      /^(.*\/[.]pyenv\/versions\/[^/]+)\/bin$/,
      /^(.*\/[.]rustup\/toolchains\/[^/]+)\/bin$/,
      /^(\/Library\/Frameworks\/[^/]+[.]framework\/Versions\/[^/]+)\/bin$/,
      /^(.*\/Library\/Android\/sdk)\/(?:emulator|platform-tools|cmdline-tools\/[^/]+\/bin)$/,
      /^(.*\/[.]cache\/codex-runtimes\/[^/]+\/dependencies)\/bin(?:\/[^/]+)?$/,
    ];
    for (const pattern of versionedBinPatterns) {
      const match = pattern.exec(canonical);
      if (match) roots.push(match[1]);
    }
    if ([logical, canonical].some((directory) =>
      directory === "/opt/homebrew/bin" || directory === "/opt/homebrew/sbin")) {
      // Homebrew's public bin directories are symlink farms. The executable,
      // its libexec helpers, and its linked libraries live under these
      // package-only roots; user data and Homebrew service config stay out.
      roots.push(
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/opt/homebrew/Cellar",
        "/opt/homebrew/opt",
        "/opt/homebrew/lib",
        "/opt/homebrew/share",
        "/opt/homebrew/etc/gitconfig",
      );
    }
    if ([logical, canonical].some((directory) =>
      directory === "/usr/local/bin" || directory === "/usr/local/sbin")) {
      // Intel Homebrew and the official Node installer both expose launchers
      // here while keeping their runtime modules below narrower descendants.
      // Do not admit /usr/local itself: it may contain unrelated user data.
      roots.push(
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/local/Cellar",
        "/usr/local/opt",
        "/usr/local/lib",
        "/usr/local/share",
        "/usr/local/etc/gitconfig",
      );
    }
    return roots;
  });
  return [...new Set([
    // The logical launcher may sit beside unrelated user scripts (commonly
    // ~/.local/bin), so admit that symlink/file exactly. Cursor's canonical
    // installation directory is a real multi-file runtime and remains the
    // smallest viable subtree. The host Node/Electron binary is exact unless
    // it belongs to an application bundle.
    ...commandExecutables.flatMap(({ logical, canonical }) => [logical, canonical]),
    ...hostExecutables.flatMap(({ logical, canonical }) => [logical, canonical]),
    ...commandRuntimeRoots,
    ...hostAppRoots,
    // PATH selects inherited developer tools, but an arbitrary PATH directory
    // is not itself read authority: it might be /, HOME, or a symlink to
    // either. Admit only narrowly recognized installation roots so npm, git,
    // package-managed and versioned tools can load their helpers without
    // making the rest of the user's home directory readable.
    ...toolchainRoots,
    "/System",
    "/Library/Apple",
    // Compiler drivers and their SDK/linker support are read-only toolchains;
    // their children inherit this same repo-write/network/process boundary.
    "/Library/Developer/CommandLineTools",
    "/Applications/Xcode.app",
    "/bin",
    "/sbin",
    "/usr/bin",
    "/usr/lib",
    "/usr/libexec",
    "/usr/sbin",
    "/usr/share",
    "/private/etc/hosts",
    "/private/etc/localtime",
    "/private/etc/nsswitch.conf",
    "/private/etc/paths",
    "/private/etc/paths.d",
    "/private/etc/resolv.conf",
    "/private/etc/ssl",
    "/private/var/db/timezone",
    "/private/var/run/resolv.conf",
    // Device nodes remain kernel-permission constrained; Node/Cursor require
    // random/null/stdio devices during startup and child execution.
    "/dev",
  ].filter(existsSync).map((path) => realpathSync(path)))];
}

export function cursorSandboxPathVariants(path: string): string[] {
  const logical = resolve(path);
  let canonical = logical;
  try {
    canonical = realpathSync(logical);
  } catch {
    try { canonical = join(realpathSync(dirname(logical)), basename(logical)); }
    catch { /* Validation below still rejects malformed/non-absolute input. */ }
  }
  const aliases = [logical, canonical].flatMap((candidate) => {
    if (candidate === "/tmp" || candidate.startsWith("/tmp/")
      || candidate === "/var" || candidate.startsWith("/var/")
      || candidate === "/etc" || candidate.startsWith("/etc/")) {
      return [candidate, `/private${candidate}`];
    }
    if (candidate === "/private/tmp" || candidate.startsWith("/private/tmp/")
      || candidate === "/private/var" || candidate.startsWith("/private/var/")
      || candidate === "/private/etc" || candidate.startsWith("/private/etc/")) {
      return [candidate, candidate.slice("/private".length)];
    }
    return [candidate];
  });
  return [...new Set(aliases)];
}

const CURSOR_TURN_RUNTIME_DATA_PATTERN = /^\/(?:private\/)?tmp\/letagents-cursor-data-[A-Za-z0-9]{6}$/;

export function prepareCursorTurnRuntimeDataDir(): string {
  const root = mkdtempSync(join(realpathSync("/tmp"), "letagents-cursor-data-"));
  chmodSync(root, 0o700);
  if (!CURSOR_TURN_RUNTIME_DATA_PATTERN.test(root)) {
    throw new Error("Cursor's private turn data root has an unexpected identity.");
  }
  return root;
}

export function removeCursorTurnRuntimeDataDir(root: string): void {
  if (!CURSOR_TURN_RUNTIME_DATA_PATTERN.test(root)) {
    throw new Error("Refusing to remove an unexpected Cursor turn data root.");
  }
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Refusing to remove a redirected Cursor turn data root.");
    }
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function escapeCursorSandboxRegex(path: string): string {
  if (/[\x00-\x1f\x7f[\]\\^]/.test(path)) {
    throw new Error("Cursor sandbox regex paths contain unsupported characters.");
  }
  return [...path].map((character) => /[A-Za-z0-9/_-]/.test(character)
    ? character
    : `[${character}]`).join("");
}

export function validateCursorSandboxRegexes(patterns: string[] | undefined): string[] {
  if (!patterns) return [];
  if (patterns.length > 64) throw new Error("Cursor native sandbox has too many authority patterns.");
  return [...new Set(patterns.map((pattern) => {
    if (!pattern.startsWith("^")
      || !pattern.endsWith("$")
      || pattern.includes("\0")
      || Buffer.byteLength(pattern, "utf8") > 4_096) {
      throw new Error("Cursor native sandbox authority patterns must be bounded and anchored.");
    }
    try {
      new RegExp(pattern);
    } catch {
      throw new Error("Cursor native sandbox authority pattern is invalid.");
    }
    return pattern;
  }))];
}

import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

type DesktopPackageMetadata = {
  letagentsRuntime?: {
    mcpVersion?: unknown;
  };
};

const desktopPackage = createRequire(import.meta.url)(
  "../../../package.json",
) as DesktopPackageMetadata;
const configuredVersion = desktopPackage.letagentsRuntime?.mcpVersion;
if (typeof configuredVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(configuredVersion)) {
  throw new Error("apps/desktop/package.json must declare letagentsRuntime.mcpVersion.");
}

/** Exact MCP package version installed into the signed desktop artifact. */
export const LETAGENTS_MCP_RUNTIME_VERSION = configuredVersion;
// Generated from the complete symlink-free node_modules tree installed by the
// committed desktop runtime lock. Packaging and every production resolution
// recompute it; changing runtime code requires an intentional constant update.
export const LETAGENTS_MCP_RUNTIME_TREE_SHA256 = "2768f0b7f94fb7cdc84f6cd4fb9fce44cfa57f51d088a0f560fdeadd6df7fe07";

const MAX_RUNTIME_TREE_ENTRIES = 20_000;
const MAX_RUNTIME_TREE_BYTES = 128 * 1024 * 1024;

export interface LetAgentsMcpRuntime {
  entryPath: string;
  /** Exact package/dependency trees required under strict registry inspection. */
  readRoots: string[];
}

/**
 * Resolve the immutable MCP runtime shipped with the desktop app. Development
 * may opt into one explicit locally-built entry through the daemon's existing
 * dual environment gate; production never falls back to npx or PATH.
 */
export function resolveLetAgentsMcpRuntime(input: {
  devEntryPath?: string | null;
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  /** Test-only digest override for a synthetic bundled runtime fixture. */
  expectedBundledTreeSha256?: string;
} = {}): LetAgentsMcpRuntime {
  const env = input.env ?? process.env;
  const devEntry = input.devEntryPath?.trim() || "";
  if (devEntry) {
    if (!env.LETAGENTS_DESKTOP_DEV_SERVER_URL?.trim()) {
      throw new Error("A local LetAgents MCP runtime is allowed only in explicit desktop development mode.");
    }
    return inspectRuntimeEntry(devEntry, "development");
  }

  const resourcesPath = input.resourcesPath
    ?? (typeof process.resourcesPath === "string" ? process.resourcesPath : "");
  if (resourcesPath) {
    const runtimeRoot = join(resourcesPath, "app", "runtime", "letagents");
    const bundledEntry = join(
      runtimeRoot,
      "node_modules",
      "letagents",
      "dist",
      "mcp",
      "server.js",
    );
    if (existsSync(bundledEntry)) {
      const expectedTreeSha256 = input.expectedBundledTreeSha256
        ?? LETAGENTS_MCP_RUNTIME_TREE_SHA256;
      assertUnredirectedRuntimePath(runtimeRoot, bundledEntry);
      const actualTreeSha256 = verifiedRuntimeTreeSha256(join(runtimeRoot, "node_modules"), expectedTreeSha256);
      if (actualTreeSha256 !== expectedTreeSha256) {
        throw new Error(
          `The bundled LetAgents MCP runtime failed its complete tree integrity check (expected ${expectedTreeSha256}, found ${actualTreeSha256}).`,
        );
      }
      return inspectRuntimeEntry(bundledEntry, "bundled");
    }
  }

  throw new Error(
    "The packaged LetAgents MCP runtime is unavailable. Reinstall LetAgents Desktop; supervised Cursor never downloads executable bridge code at turn time.",
  );
}

/**
 * Fingerprints of trees that already matched their sealed digest, keyed by
 * (dependency root, expected digest). The fingerprint covers the lstat
 * metadata (device, inode, mode, size, mtime and ctime in nanoseconds) of
 * every entry.
 *
 * Every resolution still walks the complete tree and applies every structural
 * rule (no symlinks, regular files only, entry and byte bounds). Only the file
 * reads and the SHA-256 are skipped, and only while every entry's metadata is
 * identical to the walk that produced the matching digest. Any write, rename,
 * replacement or chmod changes ctime, which an unprivileged process cannot
 * set, so it forces a full re-hash. Measured on the shipped tree (7.6k
 * entries, 45 MB): about 180 ms warm for the hash, about 35 ms for the walk.
 *
 * Racy entries (git's "racily clean" rule): a filesystem with coarse
 * timestamps could hide a same-size write made in the same tick as the walk,
 * so a tree with any ctime this close to the walk is never remembered.
 *
 * TOCTOU: the window is unchanged. The tree can still change between this
 * check and the moment Node loads a file, exactly as before; because the
 * metadata walk runs on every resolution, the memo does not widen it.
 */
const verifiedRuntimeTrees = new Map<string, string>();
const VERIFIED_RUNTIME_TREE_LIMIT = 8;
const RACY_CTIME_WINDOW_NS = 2_000_000_000n;

/** Test-only: forget every verified tree fingerprint. */
export function clearLetAgentsMcpRuntimeVerificationCacheForTest(): void {
  verifiedRuntimeTrees.clear();
}

/** Test-only counters: how many complete-tree hashes and metadata walks ran. */
export const letAgentsMcpRuntimeTreeWalkCountsForTest = { hashes: 0, metadataWalks: 0 };

function verifiedRuntimeTreeSha256(nodeModulesRoot: string, expectedTreeSha256: string): string {
  const key = JSON.stringify([resolve(nodeModulesRoot), expectedTreeSha256]);
  const remembered = verifiedRuntimeTrees.get(key);
  if (remembered !== undefined) {
    if (walkLetAgentsMcpRuntimeTree(nodeModulesRoot, false).fingerprint === remembered) {
      return expectedTreeSha256;
    }
    verifiedRuntimeTrees.delete(key);
  }
  const { digest, fingerprint, newestCtimeNs, startedNs } = walkLetAgentsMcpRuntimeTree(nodeModulesRoot, true);
  if (digest === expectedTreeSha256 && newestCtimeNs + RACY_CTIME_WINDOW_NS < startedNs) {
    if (verifiedRuntimeTrees.size >= VERIFIED_RUNTIME_TREE_LIMIT) {
      const oldest = verifiedRuntimeTrees.keys().next().value;
      if (oldest !== undefined) verifiedRuntimeTrees.delete(oldest);
    }
    verifiedRuntimeTrees.set(key, fingerprint);
  }
  return digest ?? "";
}

/** Compute the deterministic digest used to seal the complete runtime tree. */
export function computeLetAgentsMcpRuntimeTreeSha256(nodeModulesRoot: string): string {
  return walkLetAgentsMcpRuntimeTree(nodeModulesRoot, true).digest ?? "";
}

function walkLetAgentsMcpRuntimeTree(
  nodeModulesRoot: string,
  readContents: boolean,
): { digest: string | null; fingerprint: string; newestCtimeNs: bigint; startedNs: bigint } {
  const startedNs = BigInt(Date.now()) * 1_000_000n;
  let newestCtimeNs = 0n;
  if (readContents) letAgentsMcpRuntimeTreeWalkCountsForTest.hashes += 1;
  else letAgentsMcpRuntimeTreeWalkCountsForTest.metadataWalks += 1;
  const logicalRoot = resolve(nodeModulesRoot);
  const rootStat = lstatSync(logicalRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("The LetAgents MCP runtime dependency root must be a real directory.");
  }
  const hash = readContents ? createHash("sha256") : null;
  const metadata = createHash("sha256");
  const recordMetadata = (relativePath: string, stat: BigIntStats): void => {
    if (stat.ctimeNs > newestCtimeNs) newestCtimeNs = stat.ctimeNs;
    metadata.update(JSON.stringify([
      relativePath,
      String(stat.dev),
      String(stat.ino),
      String(stat.mode),
      String(stat.size),
      String(stat.mtimeNs),
      String(stat.ctimeNs),
    ]));
  };
  recordMetadata("", rootStat);
  let entries = 0;
  let bytes = 0;

  const walk = (directory: string, relativeDirectory: string): void => {
    const opened = opendirSync(directory);
    const names: string[] = [];
    try {
      for (;;) {
        const entry = opened.readSync();
        if (!entry) break;
        names.push(entry.name);
      }
    } finally {
      opened.closeSync();
    }
    names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const name of names) {
      entries += 1;
      if (entries > MAX_RUNTIME_TREE_ENTRIES) {
        throw new Error("The LetAgents MCP runtime contains too many entries.");
      }
      const path = join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      // Metadata is taken before any read: a write after this point changes
      // ctime, so a later resolution cannot reuse this walk's verdict.
      const stat = lstatSync(path, { bigint: true });
      if (stat.isSymbolicLink()) {
        throw new Error(`The LetAgents MCP runtime contains a redirected entry: ${relativePath}`);
      }
      recordMetadata(relativePath, stat);
      if (stat.isDirectory()) {
        walk(path, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`The LetAgents MCP runtime contains a non-file entry: ${relativePath}`);
      }
      const size = Number(stat.size);
      bytes += size;
      if (bytes > MAX_RUNTIME_TREE_BYTES) {
        throw new Error("The LetAgents MCP runtime exceeds its complete tree size bound.");
      }
      if (!hash) continue;
      const data = readRuntimeFileNoFollow(path, size);
      const pathBytes = Buffer.from(relativePath, "utf8");
      const header = Buffer.allocUnsafe(16);
      header.writeBigUInt64BE(BigInt(pathBytes.length), 0);
      header.writeBigUInt64BE(BigInt(data.length), 8);
      hash.update(header);
      hash.update(pathBytes);
      hash.update(data);
    }
  };
  walk(logicalRoot, "");
  return {
    digest: hash ? hash.digest("hex") : null,
    fingerprint: metadata.digest("hex"),
    newestCtimeNs,
    startedNs,
  };
}

function assertUnredirectedRuntimePath(runtimeRoot: string, entryPath: string): void {
  const root = resolve(runtimeRoot);
  const suffix = relative(root, resolve(entryPath));
  if (!suffix || suffix.startsWith("..") || resolve(root, suffix) !== resolve(entryPath)) {
    throw new Error("The bundled LetAgents MCP runtime entry escapes its sealed root.");
  }
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("The bundled LetAgents MCP runtime root is redirected.");
  }
  let cursor = root;
  for (const component of suffix.split(/[\\/]+/).filter(Boolean)) {
    cursor = join(cursor, component);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`The bundled LetAgents MCP runtime path is redirected: ${cursor}`);
    }
  }
  const canonicalRoot = realpathSync(root);
  const canonicalEntry = realpathSync(entryPath);
  const canonicalSuffix = relative(canonicalRoot, canonicalEntry);
  if (!canonicalSuffix || canonicalSuffix.startsWith("..")
    || resolve(canonicalRoot, canonicalSuffix) !== canonicalEntry) {
    throw new Error("The bundled LetAgents MCP runtime canonical entry escapes its sealed root.");
  }
}

function readRuntimeFileNoFollow(path: string, expectedSize: number): Buffer {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.size !== expectedSize) {
      throw new Error("runtime file changed before it could be verified");
    }
    const data = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd);
    if (offset !== data.length || after.size !== before.size
      || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs) {
      throw new Error("runtime file changed while it was being verified");
    }
    return data;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function inspectRuntimeEntry(entryPath: string, label: string): LetAgentsMcpRuntime {
  if (!isAbsolute(entryPath)) throw new Error(`The ${label} LetAgents MCP runtime entry must be absolute.`);
  const logicalEntry = resolve(entryPath);
  const entryStat = lstatSync(logicalEntry);
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
    throw new Error(`The ${label} LetAgents MCP runtime entry must be a real file.`);
  }
  const entry = realpathSync(logicalEntry);
  const packageRoot = findLetAgentsPackageRoot(entry);
  const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (metadata.name !== "letagents" || metadata.version !== LETAGENTS_MCP_RUNTIME_VERSION) {
    throw new Error(
      `The ${label} LetAgents MCP runtime must be letagents@${LETAGENTS_MCP_RUNTIME_VERSION}.`,
    );
  }
  const packageParent = dirname(packageRoot);
  const dependencyRoot = basename(packageParent) === "node_modules"
    ? packageParent
    : join(packageRoot, "node_modules");
  if (!existsSync(dependencyRoot)) {
    throw new Error(`The ${label} LetAgents MCP runtime dependencies are unavailable.`);
  }
  const canonicalDependencyRoot = realpathSync(dependencyRoot);
  if (!lstatSync(canonicalDependencyRoot).isDirectory()) {
    throw new Error(`The ${label} LetAgents MCP runtime dependencies are unavailable.`);
  }
  return {
    entryPath: entry,
    readRoots: [...new Set([realpathSync(packageRoot), canonicalDependencyRoot])],
  };
}

function findLetAgentsPackageRoot(entryPath: string): string {
  let current = dirname(entryPath);
  for (;;) {
    const metadataPath = join(current, "package.json");
    if (existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { name?: unknown };
        if (metadata.name === "letagents") return realpathSync(current);
      } catch {
        // Keep walking; the exact package root is validated once found.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("The LetAgents MCP runtime entry is not inside a letagents package.");
}

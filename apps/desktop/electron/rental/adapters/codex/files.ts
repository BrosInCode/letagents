import { existsSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface DiscoveredCodexFile {
  path: string;
  mtimeMs: number;
}

export function defaultCodexSessionsDir(homeOverride?: string): string {
  return join(homeOverride ?? homedir(), ".codex", "sessions");
}

export async function discoverCodexJsonlFiles(
  roots: string[],
  maxDepth: number,
): Promise<DiscoveredCodexFile[]> {
  const byPath = new Map<string, DiscoveredCodexFile>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const file of await discoverJsonlFiles(root, maxDepth)) {
      byPath.set(file.path, file);
    }
  }
  return Array.from(byPath.values());
}

export async function readSessionTail(path: string, maxBytes: number): Promise<string> {
  const fileStat = await stat(path);
  if (fileStat.size <= maxBytes) return readFile(path, "utf8");

  const handle = await open(path, "r");
  try {
    const start = Math.max(0, fileStat.size - maxBytes);
    const buffer = Buffer.alloc(fileStat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function discoverJsonlFiles(path: string, depth: number): Promise<DiscoveredCodexFile[]> {
  const pathStat = await stat(path);
  if (pathStat.isFile()) {
    return path.endsWith(".jsonl") ? [{ path, mtimeMs: pathStat.mtimeMs }] : [];
  }
  if (!pathStat.isDirectory()) return [];
  const files: DiscoveredCodexFile[] = [];
  await walkJsonlFiles(path, depth, files);
  return files;
}

async function walkJsonlFiles(
  dir: string,
  depth: number,
  out: DiscoveredCodexFile[],
): Promise<void> {
  if (depth < 0) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkJsonlFiles(path, depth - 1, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      const fileStat = await stat(path);
      out.push({ path, mtimeMs: fileStat.mtimeMs });
    } catch {
      // Source discovery is best-effort. A live Codex process can rotate
      // or remove a file between readdir and stat.
    }
  }
}

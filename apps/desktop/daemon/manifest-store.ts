import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

import type { DaemonManifest } from "./types.js";

type StoredManifest = { manifest: DaemonManifest; checksum: string };

export class ManifestConflictError extends Error {}

function checksum(manifest: DaemonManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export class ManifestStore {
  constructor(readonly path: string) {}

  async load(): Promise<DaemonManifest> {
    try {
      const stored = JSON.parse(await readFile(this.path, "utf8")) as StoredManifest;
      if (!stored.manifest || stored.checksum !== checksum(stored.manifest)) throw new Error("checksum mismatch");
      return stored.manifest;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { generation: 0, entries: [] };
      await this.quarantine();
      return { generation: 0, entries: [] };
    }
  }

  async write(expectedGeneration: number, entries: DaemonManifest["entries"]): Promise<DaemonManifest> {
    const current = await this.load();
    if (current.generation !== expectedGeneration) {
      throw new ManifestConflictError(`Manifest generation ${current.generation} does not match expected ${expectedGeneration}.`);
    }
    const manifest: DaemonManifest = { generation: expectedGeneration + 1, entries };
    const serialized = `${JSON.stringify({ manifest, checksum: checksum(manifest) })}\n`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.path);
    const directory = await open(dirname(this.path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    return manifest;
  }

  private async quarantine(): Promise<void> {
    const quarantined = `${this.path}.corrupt-${Date.now()}`;
    await rename(this.path, quarantined).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

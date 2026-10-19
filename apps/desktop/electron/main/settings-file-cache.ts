import { stat } from "node:fs/promises";

/**
 * Small in-memory copy of a parsed settings file whose secret was decrypted.
 *
 * Problem: the model list and the grant coordinator read the Open Model settings
 * many times a minute, and each read parsed the file and asked the OS Keychain to
 * decrypt the API key again.
 * Rule: keep the loaded value while one `stat` shows the same inode, mtime and
 * size, and the same secret-storage object. The caller's `save` function drops
 * the entry (`invalidate`) before and after it writes.
 * A value is kept only when the loader says it is `cacheable`: a failed decrypt
 * or a failed read is never kept, so a locked Keychain is retried at once.
 * Bound: `maxEntries` paths (default 8), oldest dropped first.
 * Callers get a copy, so they cannot change the stored value.
 */
export class SettingsFileCache<T extends object> {
  private readonly entries = new Map<string, { fingerprint: string | null; owner: object; value: T }>();

  constructor(private readonly maxEntries = 8) {}

  async read(
    path: string,
    owner: object,
    load: () => Promise<{ value: T; cacheable: boolean }>,
  ): Promise<T> {
    const fingerprint = await fingerprintOf(path);
    const cached = this.entries.get(path);
    if (cached && cached.owner === owner && cached.fingerprint === fingerprint) return { ...cached.value };
    const loaded = await load();
    if (loaded.cacheable) {
      this.entries.delete(path);
      this.entries.set(path, { fingerprint, owner, value: { ...loaded.value } });
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    } else {
      this.entries.delete(path);
    }
    return loaded.value;
  }

  invalidate(path?: string): void {
    if (path === undefined) this.entries.clear();
    else this.entries.delete(path);
  }

  size(): number {
    return this.entries.size;
  }
}

async function fingerprintOf(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return `${info.ino}:${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
}

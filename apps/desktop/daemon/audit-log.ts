import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

import type { Transition } from "./types.js";

export class AuditLog {
  constructor(readonly path: string, private readonly maxBytes = 1024 * 1024) {}

  async append(transition: Transition): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await this.rotateIfNeeded();
    await appendFile(this.path, `${JSON.stringify(transition)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      if ((await stat(this.path)).size < this.maxBytes) return;
      await rename(this.path, `${this.path}.${Date.now()}.archive`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

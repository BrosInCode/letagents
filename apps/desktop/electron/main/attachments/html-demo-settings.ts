import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { DesktopDemoSettings } from "../../ipc-types.js";
import { HTML_DEMO_CDN_HOSTS } from "./html-demo-policy.js";

/** What the person chose for demos on this computer. A missing or broken file means the defaults. */
export interface PersistedHtmlDemoSettings {
  cdnLibraries: boolean;
}

const DEFAULT_SETTINGS: PersistedHtmlDemoSettings = { cdnLibraries: true };

/**
 * The demo settings file. Main reads it once, before the first demo opens, and
 * keeps the value in memory so the request filter can read it at once. A save
 * replaces the file whole, so a crash leaves the old file or the new one.
 */
export class HtmlDemoSettingsStore {
  private current: PersistedHtmlDemoSettings | null = null;
  private loading: Promise<PersistedHtmlDemoSettings> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async read(): Promise<PersistedHtmlDemoSettings> {
    if (this.current) return { ...this.current };
    this.loading ??= this.load();
    return { ...await this.loading };
  }

  /** The value in memory: the default until `read` has loaded the file. */
  cdnLibraries(): boolean {
    return (this.current ?? DEFAULT_SETTINGS).cdnLibraries;
  }

  async setCdnLibraries(enabled: boolean): Promise<PersistedHtmlDemoSettings> {
    await this.read();
    const next = { cdnLibraries: enabled };
    this.current = next;
    // Saves run one at a time, so the file ends with the last choice.
    const write = this.writes.then(() => this.persist(next));
    this.writes = write.catch(() => undefined);
    await write;
    return { ...next };
  }

  private async load(): Promise<PersistedHtmlDemoSettings> {
    let loaded = DEFAULT_SETTINGS;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<PersistedHtmlDemoSettings> | null;
      if (parsed && typeof parsed === "object" && typeof parsed.cdnLibraries === "boolean") loaded = { cdnLibraries: parsed.cdnLibraries };
    } catch {
      // Missing or unreadable: the defaults.
    }
    // A save that finished while the file loaded wins.
    this.current ??= loaded;
    return this.current;
  }

  private async persist(settings: PersistedHtmlDemoSettings): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/** The settings as the app shows them. */
export function desktopDemoSettings(settings: PersistedHtmlDemoSettings): DesktopDemoSettings {
  return { cdnLibraries: settings.cdnLibraries, cdnHosts: [...HTML_DEMO_CDN_HOSTS.keys()] };
}

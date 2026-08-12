import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { DesktopRentalLaunchConfiguration } from "../ipc-types/rental.js";

export type RentalLaunchJournalEntry = {
  sessionId: string;
  launchAttempt: number;
  entryId: string;
  roomId: string;
  state: "accepting" | "launching" | "active" | "stopping" | "stopped" | "failed";
  configuration?: DesktopRentalLaunchConfiguration;
  deadlineAt?: string | null;
  updatedAt: string;
};

type RentalLaunchJournal = { version: 1; entries: Record<string, RentalLaunchJournalEntry> };
const tails = new Map<string, Promise<void>>();

function journalPath(): string {
  return process.env.LETAGENTS_RENTAL_LAUNCH_JOURNAL_PATH?.trim()
    || join(homedir(), ".letagents", "desktop", "rental-launch-journal.json");
}

async function read(): Promise<RentalLaunchJournal> {
  try {
    const parsed = JSON.parse(await readFile(journalPath(), "utf8")) as Partial<RentalLaunchJournal>;
    return parsed.version === 1 && parsed.entries && typeof parsed.entries === "object"
      ? { version: 1, entries: parsed.entries }
      : { version: 1, entries: {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

async function mutate<T>(operation: (journal: RentalLaunchJournal) => T): Promise<T> {
  const path = journalPath();
  const previous = tails.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.catch(() => undefined).then(() => gate);
  tails.set(path, current);
  await previous.catch(() => undefined);
  try {
    const journal = await read();
    const result = operation(journal);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
    return result;
  } finally {
    release();
    await current;
    if (tails.get(path) === current) tails.delete(path);
  }
}

export async function readRentalLaunch(sessionId: string): Promise<RentalLaunchJournalEntry | null> {
  return (await read()).entries[sessionId] ?? null;
}

export async function listRentalLaunches(): Promise<RentalLaunchJournalEntry[]> {
  return Object.values((await read()).entries);
}

export async function writeRentalLaunch(entry: RentalLaunchJournalEntry): Promise<void> {
  await mutate((journal) => { journal.entries[entry.sessionId] = entry; });
}

export async function pruneRentalLaunches(
  cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000),
): Promise<number> {
  return mutate((journal) => {
    let removed = 0;
    for (const [sessionId, entry] of Object.entries(journal.entries)) {
      const updatedAt = Date.parse(entry.updatedAt);
      if (
        (entry.state === "stopped" || entry.state === "failed")
        && Number.isFinite(updatedAt)
        && updatedAt < cutoff.getTime()
      ) {
        delete journal.entries[sessionId];
        removed += 1;
      }
    }
    return removed;
  });
}

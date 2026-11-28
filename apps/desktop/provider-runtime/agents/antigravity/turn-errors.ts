/**
 * agy can end a prompt with `end_turn` although the model request failed: the
 * failure is the conversation's last step, with step type 17 (an error
 * message) in `conversations/<session>.db`. This reads that one step from a
 * copy of the database (agy holds the live file open), so a quota or model
 * failure ends the room turn as a failure instead of passing as an answer.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const ANTIGRAVITY_ERROR_STEP_TYPE = 17;

/** The printable text inside protobuf blobs, joined: enough to find agy's error wording. */
function printable(value: unknown): string {
  if (!(value instanceof Uint8Array)) return typeof value === "string" ? value : "";
  return Buffer.from(value).toString("latin1").replace(/[^\x20-\x7e]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Turn the text of an error step into the owner-facing reason. agy writes
 * `Error 429, Message: …, Status: RESOURCE_EXHAUSTED` or `NOT_FOUND (code 404): …`.
 * A 429 is most often the account's usage, but LetAgents reads no limits to
 * prove it (that needs a call to Google outside ACP), so the reason says "may".
 * It keeps the words "usage limit": the daemon reads them as an account limit.
 */
export function antigravityStepErrorMessage(text: string): string {
  const quota = /RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED|\bError 429\b|\(code 429\)/i.test(text);
  const reset = /quotaResetTimeStamp\W+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(text)?.[1] ?? null;
  if (quota) {
    return `You may have run out of Antigravity usage for this model. Antigravity answered with a usage limit error${reset ? `; the limit resets at ${new Date(reset).toISOString()}` : ""}. The turn ended without a reply.`;
  }
  const status = /\bError (\d{3})\b[^]*?Status:\s*([A-Z_]+)/.exec(text) ?? /\b([A-Z_]{4,}) \(code (\d{3})\)/.exec(text);
  const message = /Message:\s*([^,]{1,240})/.exec(text)?.[1]?.trim()
    ?? /\(code \d{3}\):\s*(.{1,240})/.exec(text)?.[1]?.trim();
  const code = status ? (/^\d+$/.test(status[1]!) ? `${status[2]} ${status[1]}` : `${status[1]} ${status[2]}`) : null;
  return `Antigravity's model request failed${code ? ` (${code})` : ""}${message ? `: ${message}` : "."} The turn ended without a reply.`.slice(0, 600);
}

/** The error of the conversation's last step, or null when it is not an error step or cannot be read. */
export async function readAntigravityLastStepError(databasePath: string): Promise<string | null> {
  let folder: string | null = null;
  try {
    folder = await mkdtemp(join(tmpdir(), "letagents-agy-steps-"));
    const copy = join(folder, basename(databasePath));
    await copyFile(databasePath, copy);
    // The newest steps are often still in the write-ahead log.
    for (const suffix of ["-wal", "-shm"]) await copyFile(`${databasePath}${suffix}`, `${copy}${suffix}`).catch(() => undefined);
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(copy);
    try {
      const row = database.prepare("SELECT step_type, error_details, step_payload FROM steps ORDER BY idx DESC LIMIT 1").get() as
        { step_type?: unknown; error_details?: unknown; step_payload?: unknown } | undefined;
      if (!row || Number(row.step_type) !== ANTIGRAVITY_ERROR_STEP_TYPE) return null;
      return antigravityStepErrorMessage(`${printable(row.error_details)} ${printable(row.step_payload)}`);
    } finally {
      database.close();
    }
  } catch {
    return null;
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

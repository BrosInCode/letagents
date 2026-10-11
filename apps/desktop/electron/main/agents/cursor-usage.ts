import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderUsage } from "../../../shared/provider-usage.js";

// Cursor CLI 2026.09.18: usage/usage-data.ts uses these DashboardService
// methods. Its agent-kv store persists ConversationStateStructure.token_details
// (field 5), containing used_tokens (1) and max_tokens (2). These are native
// readings, not rental-meter snapshots or estimates based on model names.
const MAX_BYTES = 1024 * 1024;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function cursorAccountUsage(period: unknown, hardLimit: unknown, at: string): ProviderUsage["account"] {
  const current = object(period), plan = object(current.planUsage), spend = object(current.spendLimitUsage), hard = object(hardLimit);
  const windows: ProviderUsage["account"]["windows"] = [];
  const end = typeof current.billingCycleEnd === "string" && /^\d{1,16}$/.test(current.billingCycleEnd)
    ? Number(current.billingCycleEnd) : number(current.billingCycleEnd);
  const resetsAt = end !== null && end > 0 && end <= 8.64e15 ? new Date(end).toISOString() : null;
  const add = (id: string, label: string, percent: number | null) => {
    if (percent !== null) windows.push({ id, label, usedPercent: Math.min(100, percent), resetsAt, observedAt: at });
  };
  // Cursor's explicit percentage includes its current plan/bucket rules and
  // bonus usage. Dividing totalSpend by the purchased plan is not equivalent.
  const limit = number(plan.limit);
  const used = plan.includedSpend === undefined ? 0 : number(plan.includedSpend);
  add("cursor-plan", "Included usage", number(plan.totalPercentUsed)
    ?? (limit !== null && limit > 0 && used !== null ? used / limit * 100 : null));
  // Only a finite, enabled personal spending cap is a percentage. Disabled,
  // unlimited and team pools must not become misleading 0%/100% dials.
  if (spend.limitType !== "team" && hard.noUsageBasedAllowed !== true) {
    // Protobuf JSON omits a zero hardLimit. A successful {} means disabled;
    // only a failed/missing GetHardLimit read permits the period fallback.
    const dollars = hardLimit !== null && typeof hardLimit === "object" && !Array.isArray(hardLimit)
      && hard.hardLimit === undefined ? 0 : number(hard.hardLimit);
    const cap = dollars !== null ? (dollars > 0 && dollars < 2147483647 ? dollars * 100 : null)
      : number(spend.individualLimit);
    const spent = spend.individualUsed === undefined ? 0 : number(spend.individualUsed);
    if (cap !== null && cap > 0 && spent !== null) add("cursor-on-demand", "On-demand", spent / cap * 100);
  }
  return { state: windows.length ? "available" : "unavailable", windows };
}

export async function readCursorAccountUsage(authorization: string, at: string, request: typeof fetch = fetch): Promise<ProviderUsage["account"]> {
  if (!/^Bearer [^\s\0]{1,16384}$/.test(authorization)) throw new Error("Cursor usage authorization is unavailable.");
  const read = async (method: "GetCurrentPeriodUsage" | "GetHardLimit") => {
    const response = await request(`https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`, {
      method: "POST", headers: { authorization, "content-type": "application/json", "connect-protocol-version": "1" },
      body: "{}", redirect: "error", signal: AbortSignal.timeout(3000),
    });
    if (!response.ok || !response.body) throw new Error("Cursor usage read failed.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) throw new Error("Cursor usage response exceeded its limit.");
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  };
  const [period, hard] = await Promise.all([read("GetCurrentPeriodUsage"), read("GetHardLimit").catch(() => null)]);
  return cursorAccountUsage(period, hard, at);
}

/** Fail closed on redirects within the exact supervisor-owned profile. */
function regularPath(root: string, parts: string[]): string {
  if (!isAbsolute(root)) throw new Error("Cursor profile must be absolute.");
  let path = root;
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("Invalid Cursor profile.");
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]!);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
      throw new Error("Redirected Cursor usage file.");
    }
  }
  return path;
}

export function readCursorUsageOwner(configDir: string): number | null {
  try {
    const path = regularPath(configDir, ["letagents-cursor-identity.json"]);
    if (lstatSync(path).size > 16384) return null;
    const id = object(JSON.parse(readFileSync(path, "utf8"))).userId;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch { return null; }
}

// Decode only the two known protobuf messages. Skip unrelated fields without
// parsing or exposing messages, prompts, files, credentials or subagent state.
function fields(bytes: Uint8Array): Map<number, bigint | Uint8Array> {
  const result = new Map<number, bigint | Uint8Array>();
  let offset = 0;
  const varint = (): bigint => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) throw new Error("Invalid Cursor protobuf.");
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error("Invalid Cursor protobuf.");
  };
  while (offset < bytes.length) {
    const key = varint(), field = Number(key >> 3n), wire = Number(key & 7n);
    if (field < 1 || field > 536870911) throw new Error("Invalid Cursor field.");
    if (wire === 0) result.set(field, varint());
    else {
      const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - offset) throw new Error("Invalid Cursor field length.");
      if (wire === 2) result.set(field, bytes.subarray(offset, offset + length));
      offset += length;
    }
  }
  return result;
}

export type CursorContextReading = { context: ProviderUsage["context"]; rootId: string; summaryId: string | null };
export function readCursorContext(configDir: string, workspace: string, sessionId: string): CursorContextReading | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId) || !isAbsolute(workspace)) return null;
  let db: DatabaseSync | undefined;
  try {
    const parts = ["cursor", "chats", createHash("md5").update(resolve(workspace)).digest("hex"), sessionId, "store.db"];
    const path = regularPath(configDir, parts);
    let modified = lstatSync(path).mtimeMs;
    for (const suffix of ["-wal", "-shm"]) {
      try {
        const sidecar = regularPath(configDir, [...parts.slice(0, -1), `store.db${suffix}`]);
        if (suffix === "-wal") modified = Math.max(modified, lstatSync(sidecar).mtimeMs);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=50; BEGIN;");
    const row = db.prepare("SELECT value FROM meta WHERE key='0' AND length(value) <= 32768").get();
    if (typeof row?.value !== "string" || !/^(?:[a-f0-9]{2})+$/i.test(row.value)) return null;
    const metadata = object(JSON.parse(Buffer.from(row.value, "hex").toString("utf8")));
    if (metadata.agentId !== sessionId || typeof metadata.latestRootBlobId !== "string" || !/^[a-f0-9]{64}$/i.test(metadata.latestRootBlobId)) return null;
    const rootId = metadata.latestRootBlobId;
    const blob = db.prepare("SELECT data FROM blobs WHERE id=? AND length(data) <= ?").get(rootId, MAX_BYTES)?.data;
    if (!(blob instanceof Uint8Array)) return null;
    const state = fields(blob), details = state.get(5), summary = state.get(6);
    if (!(details instanceof Uint8Array)) return { rootId, summaryId: null, context: null };
    const tokens = fields(details), used = tokens.get(1) ?? 0n, capacity = tokens.get(2) ?? 0n;
    if (typeof used !== "bigint" || typeof capacity !== "bigint" || used > 0xffffffffn || capacity > 0xffffffffn) return null;
    return { rootId, summaryId: summary instanceof Uint8Array ? Buffer.from(summary).toString("hex") : null,
      context: tokens.has(1) || tokens.has(2) ? { usedTokens: Number(used), capacityTokens: capacity > 0 ? Number(capacity) : null, observedAt: new Date(modified).toISOString() } : null };
  } catch { return null; }
  finally { db?.close(); }
}

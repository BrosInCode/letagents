import { readFile } from "node:fs/promises";

import type {
  AntigravityLane,
  AntigravityQuotaDocument,
} from "./types.js";

export async function readAntigravityQuotaFile(
  path: string,
  maxFileBytes: number,
): Promise<AntigravityQuotaDocument | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  if (text.length > maxFileBytes) {
    text = text.slice(0, maxFileBytes);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return parseQuotaDocument(raw);
}

export function parseQuotaDocument(raw: unknown): AntigravityQuotaDocument | null {
  if (!isObject(raw)) return null;
  const versionRaw = raw.version;
  if (typeof versionRaw !== "number" || !Number.isFinite(versionRaw)) return null;
  if (!Array.isArray(raw.lanes)) return null;

  const lanes: AntigravityLane[] = [];
  for (const entry of raw.lanes) {
    const parsed = parseLane(entry);
    if (parsed) lanes.push(parsed);
  }

  return {
    version: versionRaw,
    observedAt: typeof raw.observed_at === "string" ? raw.observed_at : null,
    lanes,
  };
}

function parseLane(entry: unknown): AntigravityLane | null {
  if (!isObject(entry)) return null;
  const laneIdRaw = entry.lane_id ?? entry.laneId;
  if (typeof laneIdRaw !== "string" || !laneIdRaw.trim()) return null;
  const percentRaw = entry.percent_remaining ?? entry.percentRemaining;
  if (typeof percentRaw !== "number" || !Number.isFinite(percentRaw)) return null;

  return {
    laneId: laneIdRaw.trim(),
    model: optionalString(entry.model),
    displayName:
      optionalString(entry.display_name)
      ?? optionalString(entry.displayName),
    percentRemaining: clamp01(percentRaw),
    resetAt: pickOptionalString(entry, "reset_at", "resetAt"),
    lastEventAt: pickOptionalString(entry, "last_event_at", "lastEventAt"),
  };
}

function pickOptionalString(
  source: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = optionalString(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

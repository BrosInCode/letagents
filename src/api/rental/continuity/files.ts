import {
  CONTEXT_FILE_EXPOSED,
  EDIT_PROPOSED,
  PATCH_PROPOSED,
} from "../activity-event-types.js";
import {
  asObject,
  isoTs,
  readPathItem,
  readString,
} from "./helpers.js";
import type {
  ContinuityFileEntry,
  ContinuityPackEvent,
} from "./types.js";

export function collectFilesTouched(
  events: ReadonlyArray<ContinuityPackEvent>,
): ContinuityFileEntry[] {
  const byPath = new Map<string, ContinuityFileEntry>();

  for (const event of events) {
    const payload = asObject(event.payload);
    if (!payload) continue;

    if (event.event_type === CONTEXT_FILE_EXPOSED) {
      const path = readString(payload, "path");
      if (!path) continue;
      mergeFile(byPath, {
        path,
        reason: readString(payload, "reason") ?? "exposed",
        lastTouchedAt: isoTs(event.created_at),
        source: event.source,
        scopeApproved: true,
      });
      continue;
    }

    if (event.event_type !== EDIT_PROPOSED && event.event_type !== PATCH_PROPOSED) {
      continue;
    }

    const raw = payload.files ?? payload.paths ?? [];
    if (!Array.isArray(raw)) continue;

    for (const item of raw) {
      const path = readPathItem(item);
      if (!path) continue;
      mergeFile(byPath, {
        path,
        reason: event.event_type === PATCH_PROPOSED ? "patch_proposed" : "edit_proposed",
        lastTouchedAt: isoTs(event.created_at),
        source: event.source,
        scopeApproved: false,
      });
    }
  }

  return [...byPath.values()].sort((a, b) =>
    b.lastTouchedAt.localeCompare(a.lastTouchedAt),
  );
}

function mergeFile(
  byPath: Map<string, ContinuityFileEntry>,
  entry: ContinuityFileEntry,
): void {
  const existing = byPath.get(entry.path);
  if (!existing) {
    byPath.set(entry.path, entry);
    return;
  }

  if (entry.lastTouchedAt > existing.lastTouchedAt) {
    byPath.set(entry.path, {
      ...entry,
      scopeApproved: existing.scopeApproved || entry.scopeApproved,
    });
    return;
  }

  existing.scopeApproved = existing.scopeApproved || entry.scopeApproved;
}

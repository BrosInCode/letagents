import {
  EDIT_PROPOSED,
  PATCH_PROPOSED,
} from "../activity-event-types.js";
import {
  asObject,
  isoTs,
  readString,
} from "./helpers.js";
import type {
  ContinuityActiveDiff,
  ContinuityPackEvent,
} from "./types.js";

export function collectActiveDiff(
  events: ReadonlyArray<ContinuityPackEvent>,
): ContinuityActiveDiff | null {
  let active: ContinuityActiveDiff | null = null;

  for (const event of events) {
    if (event.event_type !== PATCH_PROPOSED && event.event_type !== EDIT_PROPOSED) {
      continue;
    }

    const payload = asObject(event.payload);
    if (!payload) continue;

    const candidate: ContinuityActiveDiff = {
      patchId: readString(payload, "patch_id", "patchId"),
      proposedAt: isoTs(event.created_at),
      source: event.source,
      summary: readString(payload, "summary"),
      diffRef: readString(payload, "diff_ref", "diffRef"),
      diffPreview: readString(payload, "diff_preview", "diffPreview"),
    };

    if (!active || candidate.proposedAt > active.proposedAt) {
      active = candidate;
    }
  }

  return active;
}

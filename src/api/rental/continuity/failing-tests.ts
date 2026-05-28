import { PATCH_GATE_TESTS_FAILED } from "../activity-event-types.js";
import {
  asObject,
  isoTs,
  readString,
} from "./helpers.js";
import type {
  ContinuityFailingTestEntry,
  ContinuityPackEvent,
} from "./types.js";

export function collectFailingTests(
  events: ReadonlyArray<ContinuityPackEvent>,
): ContinuityFailingTestEntry[] {
  const out: ContinuityFailingTestEntry[] = [];

  for (const event of events) {
    if (event.event_type !== PATCH_GATE_TESTS_FAILED) continue;

    const payload = asObject(event.payload);
    if (!payload) continue;

    const testsRaw = payload.tests ?? payload.failing_tests ?? [];
    if (!Array.isArray(testsRaw)) continue;

    for (const item of testsRaw) {
      const test = readFailingTestName(item);
      if (!test) continue;

      out.push({
        test,
        failedAt: isoTs(event.created_at),
        details: readFailingTestDetails(item),
      });
    }
  }

  return out;
}

function readFailingTestName(item: unknown): string | null {
  if (typeof item === "string") return item;

  const obj = asObject(item);
  return obj ? readString(obj, "name", "test") : null;
}

function readFailingTestDetails(item: unknown): string | null {
  const obj = asObject(item);
  return obj ? readString(obj, "details") : null;
}

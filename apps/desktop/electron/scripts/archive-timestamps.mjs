import { lutimes, readdir } from "node:fs/promises";
import { join } from "node:path";

/** The time every unchanged file in the macOS update ZIP carries, in every release. */
export const ARCHIVE_TIMESTAMP = new Date("2020-01-01T00:00:00Z");

/**
 * Give every file, folder and link in `bundle` the same fixed time, so a
 * file that did not change between releases has the same ZIP entry bytes
 * and the differential update reuses it instead of downloading it again.
 * The bundle folder, Contents and Contents/Info.plist keep `now`, so Finder
 * and Launch Services still see that the app changed. Code signatures do not
 * cover file times.
 */
export async function normalizeBundleTimestamps(bundle, { now = new Date(), time = ARCHIVE_TIMESTAMP } = {}) {
  let count = 0;
  for (const entry of await readdir(bundle, { withFileTypes: true, recursive: true })) {
    await lutimes(join(entry.parentPath, entry.name), time, time);
    count += 1;
  }
  for (const path of [join(bundle, "Contents", "Info.plist"), join(bundle, "Contents"), bundle]) {
    await lutimes(path, now, now);
  }
  return count;
}

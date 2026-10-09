import { pool } from "../../db/client.js";
import {
  describeError,
  repairUnappliedMergeEvents,
  summarizeMergeRepair,
} from "./unapplied-merge-repair.js";

// One-time repair, run by an operator in the API container:
//   node dist/api/github/room-event-projection/repair-unapplied-merge-events.js          (dry run)
//   node dist/api/github/room-event-projection/repair-unapplied-merge-events.js --apply  (moves the cards)

const args = process.argv.slice(2);
const usage = "Usage: repair-unapplied-merge-events.js [--apply]\n"
  + "Without --apply it is a dry run and changes nothing.";

if (args.includes("--help") || args.includes("-h")) {
  console.log(usage);
  await pool.end();
} else if (args.some((arg) => arg !== "--apply")) {
  console.error(`Unknown argument: ${args.find((arg) => arg !== "--apply")}\n${usage}`);
  process.exitCode = 2;
  await pool.end();
} else {
  try {
    const report = await repairUnappliedMergeEvents({
      apply: args.includes("--apply"),
      log: (line) => console.log(line),
    });
    for (const line of summarizeMergeRepair(report)) console.log(line);
    // A card that failed, or that moved without its shared artifact, needs a look.
    if (report.lines.some((line) => line.decision.kind === "failed"
      || (line.decision.kind === "moved" && line.decision.artifactSyncError !== undefined))) {
      process.exitCode = 1;
    }
  } catch (error) {
    // The cause only: a failed query's own text carries task titles.
    console.error(`Failed to repair unapplied merge events: ${describeError(error)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

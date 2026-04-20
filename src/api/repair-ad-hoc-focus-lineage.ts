import { pool } from "./db/client.js";
import { repairAdHocFocusLineage } from "./focus-lineage-repair.js";

try {
  await repairAdHocFocusLineage(pool);
  console.log("Repaired rooms_focus_lineage_check for ad-hoc Focus Rooms.");
} catch (error) {
  console.error("Failed to repair rooms_focus_lineage_check.", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}

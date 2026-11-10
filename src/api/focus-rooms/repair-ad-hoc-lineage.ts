import { pool } from "../db/client.js";
import { repairAdHocFocusLineage } from "./lineage-repair.js";

try {
  const result = await repairAdHocFocusLineage(pool);
  console.log(
    result === "repaired"
      ? "Repaired rooms_focus_lineage_check for ad-hoc Focus Rooms."
      : "rooms_focus_lineage_check already matches; no change."
  );
} catch (error) {
  console.error("Failed to repair rooms_focus_lineage_check.", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}

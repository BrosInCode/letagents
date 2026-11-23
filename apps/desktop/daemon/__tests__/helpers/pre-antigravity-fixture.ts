// Physically restore the provider constraints that shipped before Antigravity
// (daemon state v52, execution storage v25), not merely a version marker.
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { validateExecutionStorageSchema } from "../../execution-storage-schema.js";
import { validateLegacyLifecycleProjectionLedgerSchema } from "../../lifecycle-projection-ledger.js";

function narrowTables(database: DatabaseSync, names: readonly string[]): void {
  const narrowed: Array<[string, string]> = [];
  for (const name of names) {
    const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (!row) continue;
    const sql = String(row.sql);
    const next = sql
      .replace(/\s*OR \(provider='antigravity' AND native_connection_kind='antigravity_acp'\)/, "")
      .replaceAll(",'antigravity_acp'", "")
      .replaceAll(",'antigravity'", "");
    if (next !== sql) narrowed.push([name, next]);
  }
  if (!narrowed.length) return;
  const schemaVersion = Number(database.prepare("PRAGMA schema_version").get()!.schema_version);
  database.enableDefensive?.(false); // Only disposable pre-Antigravity fixtures.
  database.exec("PRAGMA writable_schema=ON");
  try {
    for (const [name, sql] of narrowed) {
      database.prepare("UPDATE sqlite_master SET sql=? WHERE type='table' AND name=?").run(sql, name);
    }
  } finally {
    database.exec(`PRAGMA writable_schema=OFF; PRAGMA schema_version=${schemaVersion + 1}`);
    database.enableDefensive?.(true);
  }
}

/** The four-provider execution CHECKs. Idempotent; the caller validates the full storage version. */
export function restorePreAntigravityExecutionStorageFixture(database: DatabaseSync): void {
  for (const table of ["execution_runtime_generations", "execution_cutover_v2"]) {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE provider='antigravity'`).get()!.n, 0);
  }
  narrowTables(database, ["execution_runtime_generations", "execution_cutover_v2"]);
}

/** The four-provider comparator ledger. Idempotent; absent ledgers are left absent. */
export function restorePreAntigravityLifecycleProjectionFixture(database: DatabaseSync): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lifecycle_projection_totals'").get()) return;
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM lifecycle_projection_lanes WHERE provider='antigravity'").get()!.n, 0);
  if (database.prepare("SELECT 1 FROM lifecycle_projection_totals WHERE provider='antigravity'").get()) {
    const noDelete = String(database.prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='lifecycle_projection_total_no_delete'",
    ).get()!.sql);
    database.exec(`DROP TRIGGER lifecycle_projection_total_no_delete;
      DELETE FROM lifecycle_projection_totals WHERE provider='antigravity';
      ${noDelete}`);
  }
  narrowTables(database, ["lifecycle_projection_lanes", "lifecycle_projection_totals"]);
}

/** A current database as the v52 daemon left it: execution storage v25 and the four-provider ledger. */
export function restorePreAntigravityProviderFixture(database: DatabaseSync): void {
  restorePreAntigravityExecutionStorageFixture(database);
  restorePreAntigravityLifecycleProjectionFixture(database);
  validateExecutionStorageSchema(database, 25);
  validateLegacyLifecycleProjectionLedgerSchema(database, "pre_antigravity");
}

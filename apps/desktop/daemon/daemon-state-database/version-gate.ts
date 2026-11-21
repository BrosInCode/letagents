import type { DatabaseSync } from "node:sqlite";
import { DAEMON_STATE_APPLICATION_ID, SCHEMA_VERSION, fromSqliteUserVersion, type Row } from "./shared.js";

export type DaemonStateDatabaseInspection = {
  kind: "empty" | "legacy" | "modern" | "foreign";
  applicationId: number;
  userVersion: number;
  schemaVersion: number;
};

/** Inspects a SQLite handle without mutating it. */
export function inspectDaemonStateDatabase(database: DatabaseSync): DaemonStateDatabaseInspection {
  const applicationId = Number((database.prepare("PRAGMA application_id").get() as Row).application_id);
  const userVersion = Number((database.prepare("PRAGMA user_version").get() as Row).user_version);
  const hasObjects = Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get(),
  );
  if (applicationId === DAEMON_STATE_APPLICATION_ID) {
    return { kind: "modern", applicationId, userVersion, schemaVersion: fromSqliteUserVersion(userVersion) };
  }
  if (applicationId === 0 && userVersion === 0 && !hasObjects) {
    return { kind: "empty", applicationId, userVersion, schemaVersion: 0 };
  }
  if (applicationId === 0) {
    return { kind: "legacy", applicationId, userVersion, schemaVersion: userVersion };
  }
  return { kind: "foreign", applicationId, userVersion, schemaVersion: 0 };
}

/**
 * Read-only compatibility gate checked before WAL conversion or schema DDL.
 * Refuses future modern schemas, unrecognized SQLite databases, and unretired
 * pre-reset legacy databases (which must be moved aside before opening).
 */
export function assertDaemonStateVersionSupported(database: DatabaseSync): number {
  const info = inspectDaemonStateDatabase(database);
  if (info.kind === "empty") return 0;
  if (info.kind === "legacy") {
    throw new Error(`Legacy daemon state schema version ${info.userVersion} must be moved aside before opening schema v${SCHEMA_VERSION}.`);
  }
  if (info.kind === "foreign") {
    throw new Error(`Unsupported SQLite database application_id ${info.applicationId}.`);
  }
  if (info.schemaVersion < 1) {
    throw new Error(`Invalid daemon state schema version ${info.schemaVersion} (user_version=${info.userVersion}).`);
  }
  if (info.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`Unsupported daemon state schema version ${info.schemaVersion} (user_version=${info.userVersion}).`);
  }
  return info.schemaVersion;
}

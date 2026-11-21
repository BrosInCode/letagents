export {
  DAEMON_STATE_APPLICATION_ID,
  DAEMON_STATE_SCHEMA_VERSION,
  DAEMON_STATE_USER_VERSION,
  DAEMON_STATE_USER_VERSION_OFFSET,
  toSqliteUserVersion,
  fromSqliteUserVersion,
  applyAgentStateVersionSchema,
  validateAgentStateVersionSchema,
} from "./shared.js";
export { inspectDaemonStateDatabase, assertDaemonStateVersionSupported, type DaemonStateDatabaseInspection } from "./version-gate.js";
export {
  DaemonStateSchema,
  DAEMON_STATE_MIGRATIONS,
  applySchemaV1,
  runNumberedMigrations,
  validateDaemonStateShape,
  type SchemaMigration,
} from "./schema.js";
export {
  DaemonStateDatabase,
  moveAsideLegacyDaemonStateDatabase,
  openDaemonStateDatabase,
  ensureDaemonStateDatabase,
  type MoveAsideLegacyOptions,
} from "./connection.js";

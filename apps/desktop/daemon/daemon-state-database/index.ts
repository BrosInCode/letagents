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
  applySchemaCurrent,
  migrateV1ToV2,
  migrateV2ToV3,
  migrateV3ToV4,
  migrateV4ToV5,
  runNumberedMigrations,
  validateDaemonStateShape,
  validateDaemonStateShapeForVersion,
  type SchemaMigration,
} from "./schema.js";
export {
  DaemonStateDatabase,
  areWindowsFiletimesCompatibleAtWmiPrecision,
  moveAsideLegacyDaemonStateDatabase,
  openDaemonStateDatabase,
  ensureDaemonStateDatabase,
  parseWindowsBirthFiletime,
  parseWindowsCimDateTimeToFiletimeUtc,
  type MoveAsideLegacyOptions,
  type OpenDaemonStateDatabaseOptions,
  type PosixBirthReadResult,
} from "./connection.js";

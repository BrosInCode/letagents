/** Version transitions v1 to v12, plus the host-tool-rule and prepared-room-context upgrades. */
import { applyManagedLaunchContractSchema } from "../managed-launch-contract.js";
import { applyHostToolRuleSchema, validateHostToolRuleSchema } from "../host-tool-rules.js";
import { applyPreparedRoomContextSchema, validatePreparedRoomContextSchema } from "../prepared-room-context.js";
import type { DatabaseSync } from "node:sqlite";
import { applyRoomWorkPublicationSchema } from "../room-work-publication-store.js";
import { applyApprovalRequestClosureSchema } from "../execution-approval-journal.js";
import { SCHEMA_VERSION, applyWorkerExecutionBindings, applyAgentImageInputColumn, applyAgentLiveSharingColumn, applyDaemonEfficiencyMigration, type Row, run, schemaMethods } from "./shared.js";

export const migrationsV1ToV12 = schemaMethods({
migrateHostToolRules(database: DatabaseSync): void {
  this.repairAndValidateCurrentShape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    applyHostToolRuleSchema(database);
    applyApprovalRequestClosureSchema(database);
    this.schemaInitializationHook?.(database);
    validateHostToolRuleSchema(database);
    applyManagedLaunchContractSchema(database);
    applyWorkerExecutionBindings(database);
    applyAgentImageInputColumn(database);
    applyAgentLiveSharingColumn(database);
    applyDaemonEfficiencyMigration(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
},

migratePreparedRoomContext(database: DatabaseSync): void {
  this.validateLocalRoomMembershipShape(database);
  this.repairAndValidateCurrentShape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    applyPreparedRoomContextSchema(database);
    applyHostToolRuleSchema(database);
    applyApprovalRequestClosureSchema(database);
    this.schemaInitializationHook?.(database);
    validatePreparedRoomContextSchema(database);
    applyManagedLaunchContractSchema(database);
    applyWorkerExecutionBindings(database);
    applyAgentImageInputColumn(database);
    applyAgentLiveSharingColumn(database);
    applyDaemonEfficiencyMigration(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
},

metadataSchemaVersion(database: DatabaseSync): number | undefined {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manifest_metadata'").get();
  if (!exists) return undefined;
  const row = database.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton = 1").get() as Row | undefined;
  return row ? Number(row.schema_version) : undefined;
},

migrateV1ToV2(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV2Shape(database, true);
    this.validateV2Shape(database);
    this.applyV3Shape(database);
    this.validateV3Shape(database);
    const requiresScrub = this.migrateWorkerShapeToV6(database);
    this.advanceDeliveryToCurrent(database);
    this.applyCurrentSchemaTail(database);
    this.applyCurrentConfigurationShape(database);
    this.schemaInitializationHook?.(database);
    applyRoomWorkPublicationSchema(database);
    applyManagedLaunchContractSchema(database);
    applyWorkerExecutionBindings(database);
    applyAgentImageInputColumn(database);
    applyAgentLiveSharingColumn(database);
    applyDaemonEfficiencyMigration(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    if (requiresScrub) this.markV6SecretScrubPending(database);
    this.applyLocalRoomMembershipShape(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
    if (requiresScrub) this.completeV6SecretScrub(database);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
},

migrateV2ToV3(database: DatabaseSync): void {
  // Audit the complete v2 shape and legacy presence encodings on every open.
  // The transaction is normally read/no-op, but also repairs partially
  // applied v2 databases whose version markers were advanced prematurely.
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV2Shape(database, true);
    this.validateV2Shape(database);
    this.applyV3Shape(database);
    this.validateV3Shape(database);
    const requiresScrub = this.migrateWorkerShapeToV6(database);
    this.advanceDeliveryToCurrent(database);
    this.applyCurrentSchemaTail(database);
    this.applyCurrentConfigurationShape(database);
    this.schemaInitializationHook?.(database);
    applyRoomWorkPublicationSchema(database);
    applyManagedLaunchContractSchema(database);
    applyWorkerExecutionBindings(database);
    applyAgentImageInputColumn(database);
    applyAgentLiveSharingColumn(database);
    applyDaemonEfficiencyMigration(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    if (requiresScrub) this.markV6SecretScrubPending(database);
    this.applyLocalRoomMembershipShape(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
    if (requiresScrub) this.completeV6SecretScrub(database);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
},

migrateV3ToV4(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    // A v3 database is already validated before we add private credentials.
    // Do not advance either version marker until the complete v4 shape exists.
    this.applyV2Shape(database, true);
    this.validateV2Shape(database);
    this.applyV3Shape(database);
    this.validateV3Shape(database);
    this.applyV4Shape(database);
    const requiresScrub = this.migrateWorkerShapeToV6(database);
    this.advanceDeliveryToCurrent(database);
    this.applyCurrentSchemaTail(database);
    this.applyCurrentConfigurationShape(database);
    this.schemaInitializationHook?.(database);
    applyRoomWorkPublicationSchema(database);
    applyManagedLaunchContractSchema(database);
    applyWorkerExecutionBindings(database);
    applyAgentImageInputColumn(database);
    applyAgentLiveSharingColumn(database);
    applyDaemonEfficiencyMigration(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    if (requiresScrub) this.markV6SecretScrubPending(database);
    this.applyLocalRoomMembershipShape(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
    if (requiresScrub) this.completeV6SecretScrub(database);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
},

repairAndValidateV3Shape(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV2Shape(database, true);
    this.validateV2Shape(database);
    this.applyV3Shape(database);
    this.validateV3Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
},

repairAndValidateV4Shape(database: DatabaseSync): void {
  // A completed v4 database is validated read-only on each open. Taking an
  // IMMEDIATE transaction merely to run CREATE IF NOT EXISTS makes a daemon
  // handoff contend with an in-flight, fenced mutation for no state benefit.
  let needsRepair = this.tableColumns(database, "reconciliation_records").has("exit_timestamps_json")
    && Boolean(database.prepare("SELECT 1 FROM reconciliation_records WHERE exit_timestamps_json IS NOT NULL LIMIT 1").get());
  try {
    this.validateV2Shape(database);
    this.validateV3Shape(database);
    this.validateV4Shape(database);
  } catch { needsRepair = true; }
  if (!needsRepair) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV2Shape(database, true);
    this.validateV2Shape(database);
    this.applyV3Shape(database);
    this.validateV3Shape(database);
    this.applyV4Shape(database);
    this.validateV4Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
},

migrateV4ToV5(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    this.validateV2Shape(database);
    this.validateV3Shape(database);
    const requiresScrub = this.migrateWorkerShapeToV6(database);
    // A real v4 database has none of the delivery v7-v9 or inspector v10
    // tables, so complete and validate the current shape before advancing
    // either version marker.
    this.advanceDeliveryToCurrent(database);
    this.applyCurrentSchemaTail(database);
    this.applyCurrentConfigurationShape(database);
    this.schemaInitializationHook?.(database);
    applyRoomWorkPublicationSchema(database);
    applyManagedLaunchContractSchema(database);
    applyWorkerExecutionBindings(database);
    applyAgentImageInputColumn(database);
    applyAgentLiveSharingColumn(database);
    applyDaemonEfficiencyMigration(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    if (requiresScrub) this.markV6SecretScrubPending(database);
    this.applyLocalRoomMembershipShape(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
    if (requiresScrub) this.completeV6SecretScrub(database);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
},

repairAndValidateV5Shape(database: DatabaseSync): void {
  // Keep the existing v2 repair path, but reject malformed private authority
  // tables rather than accepting a database whose fencing guarantees changed.
  let needsRepair = this.tableColumns(database, "reconciliation_records").has("exit_timestamps_json")
    && Boolean(database.prepare("SELECT 1 FROM reconciliation_records WHERE exit_timestamps_json IS NOT NULL LIMIT 1").get());
  try {
    this.validateV2Shape(database);
    this.validateV3Shape(database);
    this.validateV4Shape(database);
    this.validateV5Shape(database);
  } catch {
    needsRepair = true;
  }
  if (!needsRepair) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV2Shape(database, true);
    this.validateV2Shape(database);
    this.applyV3Shape(database);
    this.validateV3Shape(database);
    this.applyV4Shape(database);
    this.validateV4Shape(database);
    this.applyV5Shape(database);
    this.validateV5Shape(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
},

migrateV5ToV6(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    this.validateV2Shape(database);
    this.validateV3Shape(database);
    const requiresScrub = this.migrateWorkerShapeToV6(database);
    this.advanceDeliveryToCurrent(database);
    this.applyCurrentSchemaTail(database);
    this.applyCurrentConfigurationShape(database);
    this.schemaInitializationHook?.(database);
    applyRoomWorkPublicationSchema(database);
    applyManagedLaunchContractSchema(database);
    applyWorkerExecutionBindings(database);
    applyAgentImageInputColumn(database);
    applyAgentLiveSharingColumn(database);
    applyDaemonEfficiencyMigration(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    if (requiresScrub) this.markV6SecretScrubPending(database);
    this.applyLocalRoomMembershipShape(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
    // The old table contained a credential. secure_delete clears freed cells;
    // checkpoint + VACUUM rewrites both main and WAL before this initializer
    // returns a live v6 connection.
    if (requiresScrub) this.completeV6SecretScrub(database);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
},

migrateV6ToV7(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    this.validateV2Shape(database);
    this.validateV3Shape(database);
    this.validateV6Shape(database);
    this.advanceDeliveryToCurrent(database);
    this.applyCurrentSchemaTail(database);
    this.applyCurrentConfigurationShape(database);
    this.schemaInitializationHook?.(database);
    applyRoomWorkPublicationSchema(database);
    applyManagedLaunchContractSchema(database);
    applyWorkerExecutionBindings(database);
    applyAgentImageInputColumn(database);
    applyAgentLiveSharingColumn(database);
    applyDaemonEfficiencyMigration(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    this.applyLocalRoomMembershipShape(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
},

/** V8 is an additive, transactionally versioned inspector-history upgrade. */
migrateV7ToV8(database: DatabaseSync): void {
  // First repair exactly the v7 additive shape. This preserves the prior
  // fail-closed scrub guard before the new version marker is advanced.
  this.repairAndValidateV7Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.advanceDeliveryToCurrent(database);
    this.applyCurrentSchemaTail(database);
    this.applyCurrentConfigurationShape(database);
    this.schemaInitializationHook?.(database);
    applyRoomWorkPublicationSchema(database);
    applyManagedLaunchContractSchema(database);
    applyWorkerExecutionBindings(database);
    applyAgentImageInputColumn(database);
    applyAgentLiveSharingColumn(database);
    applyDaemonEfficiencyMigration(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    this.applyLocalRoomMembershipShape(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
},

/** V9 makes message identity room-scoped and verifies cross-table delivery evidence. */
migrateV8ToV9(database: DatabaseSync): void {
  this.repairAndValidateV8Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.advanceDeliveryToCurrent(database);
    this.applyCurrentSchemaTail(database);
    this.applyCurrentConfigurationShape(database);
    this.schemaInitializationHook?.(database);
    applyRoomWorkPublicationSchema(database);
    applyManagedLaunchContractSchema(database);
    applyWorkerExecutionBindings(database);
    applyAgentImageInputColumn(database);
    applyAgentLiveSharingColumn(database);
    applyDaemonEfficiencyMigration(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    this.applyLocalRoomMembershipShape(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
},

/** V10 adds revisioned Inspector configuration and durable room-move journals. */
migrateV9ToV10(database: DatabaseSync): void {
  this.repairAndValidateV9Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyCurrentSchemaTail(database);
    this.applyCurrentConfigurationShape(database);
    this.schemaInitializationHook?.(database);
    applyRoomWorkPublicationSchema(database);
    applyManagedLaunchContractSchema(database);
    applyWorkerExecutionBindings(database);
    applyAgentImageInputColumn(database);
    applyAgentLiveSharingColumn(database);
    applyDaemonEfficiencyMigration(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    this.applyLocalRoomMembershipShape(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
},

/** V11 binds every external purge acknowledgement to its exact worker session. */
migrateV10ToV11(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    if (this.tableColumns(database, "agent_purge_operations").size) this.rebuildPurgeOperationsV11(database);
    this.applyCurrentSchemaTail(database);
    this.applyCurrentConfigurationShape(database);
    this.schemaInitializationHook?.(database);
    applyRoomWorkPublicationSchema(database);
    applyManagedLaunchContractSchema(database);
    applyWorkerExecutionBindings(database);
    applyAgentImageInputColumn(database);
    applyAgentLiveSharingColumn(database);
    applyDaemonEfficiencyMigration(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    this.applyLocalRoomMembershipShape(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
},

/** V12 records the crash-safe local state of every supervisor worker mint. */
migrateV11ToV12(database: DatabaseSync): void {
  this.repairAndValidateV11Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyCurrentSchemaTail(database);
    this.applyCurrentConfigurationShape(database);
    this.schemaInitializationHook?.(database);
    applyRoomWorkPublicationSchema(database);
    applyManagedLaunchContractSchema(database);
    applyWorkerExecutionBindings(database);
    applyAgentImageInputColumn(database);
    applyAgentLiveSharingColumn(database);
    applyDaemonEfficiencyMigration(database);
    run(database.prepare("UPDATE manifest_metadata SET schema_version = ? WHERE singleton = 1"), SCHEMA_VERSION);
    this.applyLocalRoomMembershipShape(database);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  }
},
});

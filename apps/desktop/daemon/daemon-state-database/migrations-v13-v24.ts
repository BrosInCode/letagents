/** Version transitions v12 to v24. */
import { applyManagedLaunchContractSchema } from "../managed-launch-contract.js";
import type { DatabaseSync } from "node:sqlite";
import { migrateExecutionStorageV18ToV19, migrateExecutionStorageV19ToV20, migrateExecutionStorageV20ToV21, migrateExecutionStorageV21ToV22, migrateExecutionStorageV22ToV23, migrateExecutionStorageV23ToV24, migrateExecutionStorageV24ToV25 } from "../execution-storage-schema.js";
import { applyRoomWorkPublicationSchema } from "../room-work-publication-store.js";
import { SCHEMA_VERSION, applyWorkerExecutionBindings, applyAgentImageInputColumn, applyAgentLiveSharingColumn, applyDaemonEfficiencyMigration, run, validateTerminalResults, schemaMethods } from "./shared.js";

export const migrationsV13ToV24 = schemaMethods({
/** V13 journals safe same-process continuation repair and user cancellation. */
migrateV12ToV13(database: DatabaseSync): void {
  this.repairAndValidateV12Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV13Shape(database);
    this.validateV13Shape(database);
    this.applyV14Shape(database);
    this.validateV14Shape(database);
    this.applyV15Shape(database);
    this.validateV15Shape(database);
    this.applyV16Shape(database);
    this.validateV16Shape(database);
    this.applyV17Shape(database, true);
    this.validateV17Shape(database);
    this.applyV18Shape(database);
    this.validateV18Shape(database);
    this.applyV20Shape(database);
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

/** V14 preserves the complete OpenCode server identity across daemon handoff. */
migrateV13ToV14(database: DatabaseSync): void {
  this.repairAndValidateV13Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV14Shape(database);
    this.validateV14Shape(database);
    this.applyV15Shape(database);
    this.validateV15Shape(database);
    this.applyV16Shape(database);
    this.validateV16Shape(database);
    this.applyV17Shape(database, true);
    this.validateV17Shape(database);
    this.applyV18Shape(database);
    this.validateV18Shape(database);
    this.applyV20Shape(database);
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

/** V15 separates lifetime action replay memory from the bounded manifest view. */
migrateV14ToV15(database: DatabaseSync): void {
  this.repairAndValidateV14Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV15Shape(database);
    this.validateV15Shape(database);
    this.applyV16Shape(database);
    this.validateV16Shape(database);
    this.applyV17Shape(database, true);
    this.validateV17Shape(database);
    this.applyV18Shape(database);
    this.validateV18Shape(database);
    this.applyV20Shape(database);
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

/** V16 binds every native turn id to its immutable provider authority scope. */
migrateV15ToV16(database: DatabaseSync): void {
  this.repairAndValidateV15Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV16Shape(database);
    this.validateV16Shape(database);
    this.applyV17Shape(database, true);
    this.validateV17Shape(database);
    this.applyV18Shape(database);
    this.validateV18Shape(database);
    this.applyV20Shape(database);
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

/** V17 gives every ordinary MCP effect a durable class and honest ambiguity lifecycle. */
migrateV16ToV17(database: DatabaseSync): void {
  this.repairAndValidateV16Shape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.applyV17Shape(database, true);
    this.validateV17Shape(database);
    this.applyV18Shape(database);
    this.validateV18Shape(database);
    this.applyV20Shape(database);
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

/** V18 reserves typed execution storage without changing legacy delivery decisions. */
migrateV17ToV18(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    this.validateV17Shape(database);
    this.applyV18Shape(database);
    this.validateV18Shape(database);
    this.applyV20Shape(database);
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

/** V19 adds observer fencing and proof slots, never historical outcomes. */
migrateV18ToV19(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    this.validateV18Shape(database, 18);
    migrateExecutionStorageV18ToV19(database);
    migrateExecutionStorageV19ToV20(database);
    migrateExecutionStorageV20ToV21(database);
    migrateExecutionStorageV21ToV22(database);
    migrateExecutionStorageV22ToV23(database);
    migrateExecutionStorageV23ToV24(database);
    migrateExecutionStorageV24ToV25(database);
    this.validateV18Shape(database);
    this.applyV20Shape(database);
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

/** Upgrade terminal constraints and observer provenance without reinterpreting evidence. */
migrateV19ToV20(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    this.validateV18Shape(database, 19);
    migrateExecutionStorageV19ToV20(database);
    migrateExecutionStorageV20ToV21(database);
    migrateExecutionStorageV21ToV22(database);
    migrateExecutionStorageV22ToV23(database);
    migrateExecutionStorageV23ToV24(database);
    migrateExecutionStorageV24ToV25(database);
    this.validateV18Shape(database);
    this.applyV20Shape(database);
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

/** Add nullable source provenance without resetting observer cursors or rebuilding tables. */
migrateV20ToV21(database: DatabaseSync): void {
  this.repairAndValidateCurrentShape(database, 19);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.validateV18Shape(database, 19);
    migrateExecutionStorageV19ToV20(database);
    migrateExecutionStorageV20ToV21(database);
    migrateExecutionStorageV21ToV22(database);
    migrateExecutionStorageV22ToV23(database);
    migrateExecutionStorageV23ToV24(database);
    migrateExecutionStorageV24ToV25(database);
    this.validateV18Shape(database);
    validateTerminalResults(database, 20);
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

/** Add native cutover witness slots without manufacturing authority for old rows. */
migrateV21ToV22(database: DatabaseSync): void {
  this.repairAndValidateCurrentShape(database, 20);
  database.exec("BEGIN IMMEDIATE");
  try {
    this.validateV18Shape(database, 20);
    migrateExecutionStorageV20ToV21(database);
    migrateExecutionStorageV21ToV22(database);
    migrateExecutionStorageV22ToV23(database);
    migrateExecutionStorageV23ToV24(database);
    migrateExecutionStorageV24ToV25(database);
    this.validateV18Shape(database);
    validateTerminalResults(database, 20);
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

/** Preserve all existing polling behavior; only a future exact cutover may select custody. */
migrateV22ToV23(database: DatabaseSync): void {
  this.repairAndValidateCurrentShape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    migrateExecutionStorageV21ToV22(database);
    migrateExecutionStorageV22ToV23(database);
    migrateExecutionStorageV23ToV24(database);
    migrateExecutionStorageV24ToV25(database);
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

/** Add only a dormant journal. No historical mode, cursor, or cutover starts work. */
migrateV23ToV24(database: DatabaseSync): void {
  this.repairAndValidateCurrentShape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    migrateExecutionStorageV21ToV22(database);
    migrateExecutionStorageV22ToV23(database);
    migrateExecutionStorageV23ToV24(database);
    migrateExecutionStorageV24ToV25(database);
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
});

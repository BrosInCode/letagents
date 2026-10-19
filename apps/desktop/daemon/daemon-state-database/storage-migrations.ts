/** Version transitions from v24 on, each owned by a sibling store's schema. */
import { applyManagedLaunchContractSchema } from "../managed-launch-contract.js";
import type { DatabaseSync } from "node:sqlite";
import { migrateExecutionStorageV21ToV22, migrateExecutionStorageV22ToV23, migrateExecutionStorageV23ToV24, migrateExecutionStorageV24ToV25, validateRuntimeFailureEffectMigrationSource } from "../execution-storage-schema.js";
import { applyRoomWorkPublicationSchema, validateRoomWorkPublicationSchema } from "../room-work-publication-store.js";
import { applyExecutionApprovalPublicationSchema, validateExecutionApprovalPublicationSchema } from "../execution-approval-publication-store.js";
import { applyLifecycleProjectionLedgerSchema, resetLegacyLifecycleProjectionLedgerSchema, validateLifecycleProjectionLedgerSchema } from "../lifecycle-projection-ledger.js";
import { SCHEMA_VERSION, applyWorkerExecutionBindings, applyAgentImageInputColumn, applyAgentLiveSharingColumn, applyDaemonEfficiencyMigration, run, schemaMethods } from "./shared.js";

export const storageMigrations = schemaMethods({
/** Offers remain dormant. Old activations acquire no fabricated offer coverage. */
migratePollingOfferStorage(database: DatabaseSync): void {
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

/** Add empty publication provenance; never attribute previously captured work. */
migrateRoomWorkPublicationStorage(database: DatabaseSync): void {
  this.repairAndValidateCurrentShape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    migrateExecutionStorageV21ToV22(database);
    migrateExecutionStorageV22ToV23(database);
    migrateExecutionStorageV23ToV24(database);
    migrateExecutionStorageV24ToV25(database);
    applyRoomWorkPublicationSchema(database);
    applyLifecycleProjectionLedgerSchema(database);
    this.freezeLegacyActiveRuntimeBirths(database);
    this.retireIncompatibleCodexRuntimeBirths(database);
    this.schemaInitializationHook?.(database);
    validateRoomWorkPublicationSchema(database);
    validateLifecycleProjectionLedgerSchema(database);
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

/** Add empty comparison evidence; never infer a historical projection pair. */
migrateLifecycleProjectionStorage(database: DatabaseSync): void {
  this.repairAndValidateCurrentShape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    migrateExecutionStorageV21ToV22(database);
    migrateExecutionStorageV22ToV23(database);
    migrateExecutionStorageV23ToV24(database);
    migrateExecutionStorageV24ToV25(database);
    applyLifecycleProjectionLedgerSchema(database);
    this.freezeLegacyActiveRuntimeBirths(database);
    this.retireIncompatibleCodexRuntimeBirths(database);
    this.schemaInitializationHook?.(database);
    validateLifecycleProjectionLedgerSchema(database);
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

/** Freeze only exact pre-B1 native births as legacy; never infer current policy. */
migrateLegacyActiveRuntimeBirths(database: DatabaseSync): void {
  this.repairAndValidateCurrentShape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    migrateExecutionStorageV21ToV22(database);
    migrateExecutionStorageV22ToV23(database);
    migrateExecutionStorageV23ToV24(database);
    migrateExecutionStorageV24ToV25(database);
    this.freezeLegacyActiveRuntimeBirths(database);
    resetLegacyLifecycleProjectionLedgerSchema(database);
    this.retireIncompatibleCodexRuntimeBirths(database);
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

/** Add the effect journal and settle pre-journal facts without replaying them. */
migrateLifecycleEffectStorage(database: DatabaseSync): void {
  this.repairAndValidateCurrentShape(database, 21);
  database.exec("BEGIN IMMEDIATE");
  try {
    migrateExecutionStorageV21ToV22(database);
    migrateExecutionStorageV22ToV23(database);
    migrateExecutionStorageV23ToV24(database);
    migrateExecutionStorageV24ToV25(database);
    resetLegacyLifecycleProjectionLedgerSchema(database);
    this.retireIncompatibleCodexRuntimeBirths(database);
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

/** Extend the existing effect journal without changing any retained disposition. */
migrateRuntimeFailureEffectStorage(database: DatabaseSync): void {
  this.repairAndValidateCurrentShape(database, validateRuntimeFailureEffectMigrationSource(database));
  database.exec("BEGIN IMMEDIATE");
  try {
    migrateExecutionStorageV22ToV23(database);
    migrateExecutionStorageV23ToV24(database);
    migrateExecutionStorageV24ToV25(database);
    resetLegacyLifecycleProjectionLedgerSchema(database);
    this.retireIncompatibleCodexRuntimeBirths(database);
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

/** Retire exact Codex births that cannot satisfy typed lifecycle authority. */
migrateIncompatibleCodexRuntimeBirths(database: DatabaseSync): void {
  this.repairAndValidateCurrentShape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    migrateExecutionStorageV23ToV24(database);
    migrateExecutionStorageV24ToV25(database);
    this.retireIncompatibleCodexRuntimeBirths(database);
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

/** Start a fresh comparator epoch when the admitted provider set changes. */
migrateLifecycleProjectionProviderSet(database: DatabaseSync): void {
  this.repairAndValidateCurrentShape(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    migrateExecutionStorageV23ToV24(database);
    migrateExecutionStorageV24ToV25(database);
    resetLegacyLifecycleProjectionLedgerSchema(database);
    this.retireIncompatibleCodexRuntimeBirths(database);
    this.schemaInitializationHook?.(database);
    validateLifecycleProjectionLedgerSchema(database);
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

/** Remove mutable aliases from the dormant local delegation authority key. */
migrateExecutionDelegationAuthorityStorage(database: DatabaseSync): void {
  this.repairAndValidateCurrentShape(database, 23);
  database.exec("BEGIN IMMEDIATE");
  try {
    migrateExecutionStorageV23ToV24(database);
    migrateExecutionStorageV24ToV25(database);
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

/** Add only the dormant, sanitized delegate-display projection journal. */
migrateExecutionApprovalProjectionStorage(database: DatabaseSync): void {
  this.repairAndValidateCurrentShape(database, 24);
  database.exec("BEGIN IMMEDIATE");
  try {
    migrateExecutionStorageV24ToV25(database);
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

/** Add an empty receipt journal; prior approval projections are never pinned retroactively. */
migrateExecutionApprovalPublicationStorage(database: DatabaseSync): void {
  this.repairAndValidateCurrentShape(database, 25);
  database.exec("BEGIN IMMEDIATE");
  try {
    applyExecutionApprovalPublicationSchema(database);
    this.schemaInitializationHook?.(database);
    validateExecutionApprovalPublicationSchema(database);
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

import { validateHostToolRuleSchema } from "../host-tool-rules.js";
import { validateRoomWorkspaceSchema, validateRoomWorkspaceReviewSchema } from "../room-workspace-store.js";
import type { DatabaseSync } from "node:sqlite";
import { validateExecutionStorageSchema, validateRuntimeFailureEffectMigrationSource } from "../execution-storage-schema.js";
import { readDurableNativeFailure } from "../supervised-agent-history-retention.js";
import { validatePollingActivationSchema, validatePollingOfferSchema } from "../custodial-polling-activation.js";
import { validateRoomWorkPublicationSchema } from "../room-work-publication-store.js";
import { validateExecutionApprovalPublicationSchema } from "../execution-approval-publication-store.js";
import { validateLegacyLifecycleProjectionLedgerSchema, validateLifecycleProjectionLedgerSchema } from "../lifecycle-projection-ledger.js";
import { validateApprovalRequestClosureSchema } from "../execution-approval-journal.js";
import { SCHEMA_VERSION, type Row, validatePollingContract, validateCustodialLaunchSession, validateTerminalResults } from "./shared.js";

/** Read-only compatibility gate, also used before opening persistent WAL state. */
export function assertDaemonStateVersionSupported(database: DatabaseSync): number {
  const existingVersion = Number((database.prepare("PRAGMA user_version").get() as Row).user_version);
  const hasMetadata = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='manifest_metadata'").get();
  const metadata = hasMetadata
    ? database.prepare("SELECT schema_version FROM manifest_metadata WHERE singleton=1").get() as Row | undefined
    : undefined;
  const metadataVersion = metadata ? Number(metadata.schema_version) : undefined;
  if (existingVersion > SCHEMA_VERSION) throw new Error(`Unsupported daemon state schema version ${existingVersion}.`);
  if (metadataVersion !== undefined && metadataVersion > SCHEMA_VERSION) {
    throw new Error(`Unsupported daemon manifest metadata schema version ${metadataVersion}.`);
  }
  if (existingVersion === 0 && metadataVersion !== undefined) {
    throw new Error(`Daemon state version pair is inconsistent: user_version=0, metadata schema_version=${metadataVersion}.`);
  }
  if (existingVersion !== 0 && metadataVersion !== existingVersion) {
    throw new Error(`Daemon state version pair is inconsistent: user_version=${existingVersion}, metadata schema_version=${metadataVersion ?? "missing"}.`);
  }
  if (existingVersion >= 44) validateHostToolRuleSchema(database);
  if (existingVersion >= 39) validateRoomWorkspaceReviewSchema(database);
  if (existingVersion >= 42) validateApprovalRequestClosureSchema(database, existingVersion < 45);
  if (existingVersion >= 38) validateRoomWorkspaceSchema(database);
  if (existingVersion >= 36) validateExecutionApprovalPublicationSchema(database);
  if (existingVersion >= 27) validateRoomWorkPublicationSchema(database, existingVersion < 37);
  if (existingVersion >= 28) {
    if (existingVersion < 32) validateLegacyLifecycleProjectionLedgerSchema(database);
    else validateLifecycleProjectionLedgerSchema(database);
  }
  if (existingVersion >= 25) validatePollingOfferSchema(database, existingVersion >= 26 ? 26 : 25);
  if (existingVersion >= 24) { validatePollingActivationSchema(database, existingVersion >= 26 ? 26 : 24); validateCustodialLaunchSession(database); }
  if (existingVersion >= 23) validatePollingContract(database);
  if (existingVersion >= 18) {
    if (existingVersion === 30) validateRuntimeFailureEffectMigrationSource(database);
    else validateExecutionStorageSchema(database,
      existingVersion === 18 ? 18 : existingVersion < 21 ? 19 : existingVersion === 21 ? 20
        : existingVersion < 30 ? 21 : existingVersion < 34 ? 23 : existingVersion < 35 ? 24 : 25);
  }
  if (existingVersion >= 17) validateTerminalResults(database, existingVersion >= 20 ? 20 : undefined);
  if (existingVersion >= 20) {
    // Reject inconsistent new terminal authority before legacy upgrade repair
    // can relabel a missing binding as an old, unrecoverable no-reply turn.
    for (const row of database.prepare(`SELECT i.inbox_item_id FROM supervised_agent_inbox i
      LEFT JOIN supervised_agent_terminal_results t ON t.inbox_item_id=i.inbox_item_id
      WHERE t.outcome IN ('failed','interrupted') OR i.state='acknowledged_failed'
        OR CASE WHEN json_valid(i.outcome) THEN json_extract(i.outcome,'$.kind') END IN ('failed','interrupted')`).all() as Row[]) {
      readDurableNativeFailure(database, String(row.inbox_item_id));
    }
  }
  return existingVersion;
}

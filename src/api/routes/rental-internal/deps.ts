import { eq } from "drizzle-orm";

import { db } from "../../db/client.js";
import { rental_sessions } from "../../db/schema.js";
import { ingestUsage } from "../../rental/usage-ingest.js";
import { reconcileBudget, reserveBudget } from "../../rental/budget-orchestrator.js";
import {
  createDefaultDeps as createDefaultHeartbeatDeps,
  type HeartbeatDeps,
} from "../../rental/heartbeat.js";
import {
  defaultQuotaLeaseOrchestratorDeps,
  releaseSessionLease,
} from "../../rental/quota-lease-orchestrator.js";
import {
  createDefaultContextBrokerDeps,
  readContextFile,
  searchContext,
} from "../../rental/context-broker.js";
import { appendSignedChange as appendSignedChangeEntry } from "../../rental/signed-change-journal.js";
import {
  createDefaultPatchProposalDeps,
  proposePatch as proposePatchThroughGate,
} from "../../rental/patch-proposal.js";
import {
  createDefaultCommandBrokerDeps,
  runWorkspaceCommand as runCommandThroughBroker,
} from "../../rental/command-broker.js";
import type { RentalInternalRouteDeps } from "./types.js";

let cachedHeartbeatDeps: HeartbeatDeps | null = null;

async function defaultHeartbeatDeps(): Promise<HeartbeatDeps> {
  if (cachedHeartbeatDeps) return cachedHeartbeatDeps;
  cachedHeartbeatDeps = await createDefaultHeartbeatDeps();
  return cachedHeartbeatDeps;
}

export const defaultRentalInternalDeps: RentalInternalRouteDeps = {
  ingestUsage,
  reserveBudget,
  reconcileBudget,
  async resolveSessionAccess(sessionId, accountId) {
    const [row] = await db
      .select({
        renter: rental_sessions.renter_account_id,
        provider: rental_sessions.provider_account_id,
      })
      .from(rental_sessions)
      .where(eq(rental_sessions.id, sessionId));
    if (!row) return null;
    if (row.renter === accountId) return "renter";
    if (row.provider === accountId) return "provider";
    return null;
  },
  heartbeatDeps: defaultHeartbeatDeps,
  async getSessionForRefreshQuota(sessionId) {
    const [row] = await db
      .select()
      .from(rental_sessions)
      .where(eq(rental_sessions.id, sessionId));
    return row ?? null;
  },
  async getSessionForLiveness(sessionId) {
    const deps = await defaultHeartbeatDeps();
    return deps.getSession(sessionId);
  },
  async getSessionLifecycle(sessionId) {
    const [row] = await db
      .select({
        status: rental_sessions.status,
        room_id: rental_sessions.room_id,
      })
      .from(rental_sessions)
      .where(eq(rental_sessions.id, sessionId));
    return row ?? null;
  },
  async updateSessionLifecycle(sessionId, update) {
    const [updated] = await db
      .update(rental_sessions)
      .set({
        status: update.status,
        ended_at: update.endedAt,
        updated_at: new Date(),
      })
      .where(eq(rental_sessions.id, sessionId))
      .returning();
    return updated ?? null;
  },
  async emitActivityEvent(input) {
    const mod = await import("../../rental/activity-emitter.js");
    return mod.emitActivityEvent(input);
  },
  async releaseSessionLease(input) {
    return releaseSessionLease(input, defaultQuotaLeaseOrchestratorDeps);
  },
  async readContextFile(sessionId, input) {
    return readContextFile(createDefaultContextBrokerDeps(), {
      sessionId,
      ...input,
    });
  },
  async searchContext(sessionId, input) {
    return searchContext(createDefaultContextBrokerDeps(), {
      sessionId,
      ...input,
    });
  },
  async appendSignedChange(sessionId, input) {
    return appendSignedChangeEntry({
      sessionId,
      ...input,
    });
  },
  async proposePatch(sessionId, input) {
    return proposePatchThroughGate(createDefaultPatchProposalDeps(), {
      sessionId,
      ...input,
    });
  },
  async runWorkspaceCommand(sessionId, input) {
    return runCommandThroughBroker(createDefaultCommandBrokerDeps(), {
      sessionId,
      ...input,
    });
  },
};

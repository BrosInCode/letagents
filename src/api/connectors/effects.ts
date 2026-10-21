import type { TrackerProvider } from "../../../shared/ticket-connectors.mjs";
import type { WorkflowEffect } from "../db/types/effects.js";
import type {
  WorkflowEffectCreateResult,
  WorkflowEffectExecutor,
  WorkflowEffectLookupResult,
} from "../workflow-effects/broker.js";
import { type ConnectionService, connectorErrorText } from "./connections.js";
import { ConnectorDecryptError } from "./crypto.js";
import type { WorkItemProviders } from "./providers/index.js";
import { TrackerProviderError, type TrackerWriteResult } from "./providers/types.js";
import type { TrackerConnectionStore } from "./store.js";

interface TrackerEffectRequest {
  connection_id: string;
  key: string;
  to_status: string | null;
  body: string | null;
}

function trackerRequest(effect: WorkflowEffect): TrackerEffectRequest {
  const payload = effect.request_payload;
  return {
    connection_id: String(payload.connection_id ?? ""),
    key: String(payload.key ?? ""),
    to_status: typeof payload.to_status === "string" ? payload.to_status : null,
    body: typeof payload.body === "string" ? payload.body : null,
  };
}

/**
 * Runs `tracker_transition` and `tracker_comment` journal rows. The broker
 * owns the states; this only performs one write or one marker lookup.
 */
export function createTrackerEffectExecutor(deps: {
  store: TrackerConnectionStore;
  service: ConnectionService;
  providers: WorkItemProviders;
}): WorkflowEffectExecutor {
  async function openFor(effect: WorkflowEffect) {
    const request = trackerRequest(effect);
    const row = await deps.store.get(request.connection_id);
    if (!row || row.provider !== effect.provider) return { request, row: null, conn: null } as const;
    return { request, row, conn: deps.service.open(row) } as const;
  }

  return {
    async create(effect): Promise<WorkflowEffectCreateResult> {
      let opened: Awaited<ReturnType<typeof openFor>>;
      try {
        opened = await openFor(effect);
      } catch (error) {
        // Nothing reached the tracker yet.
        const message = error instanceof ConnectorDecryptError ? error.message : connectorErrorText(error);
        return { kind: "definite_failure", error: message };
      }
      const { request, row, conn } = opened;
      if (!row || !conn) {
        return { kind: "definite_failure", error: "The tracker connection was removed; the ticket was not changed." };
      }
      const provider = deps.providers[row.provider as TrackerProvider];
      try {
        const result = effect.kind === "tracker_transition"
          ? await provider.transition(conn, request.key, request.to_status ?? "", effect.correlation_key)
          : await provider.comment(conn, request.key, request.body ?? "", effect.correlation_key);
        return {
          kind: "succeeded",
          external_id: result.externalId,
          external_url: result.url ?? null,
          response_payload: { key: request.key, external_id: result.externalId },
        };
      } catch (error) {
        const text = await deps.service.recordFailure(row, error);
        if (error instanceof TrackerProviderError && error.outcome !== "ambiguous") {
          return { kind: "definite_failure", error: text };
        }
        return { kind: "ambiguous", error: text };
      }
    },

    async lookup(effect): Promise<WorkflowEffectLookupResult> {
      const request = trackerRequest(effect);
      let found: TrackerWriteResult | null;
      try {
        const { row, conn } = await openFor(effect);
        if (!row || !conn) {
          return { kind: "gone", error: "The tracker connection was removed, so the effect cannot be checked or retried." };
        }
        const provider = deps.providers[row.provider as TrackerProvider];
        found = effect.kind === "tracker_transition"
          ? await provider.findTransition(conn, request.key, request.to_status ?? "", effect.created_at)
          : await provider.findComment(conn, request.key, effect.correlation_key);
      } catch (error) {
        // The broker stores this text in last_error.
        throw new Error(connectorErrorText(error));
      }
      return found
        ? {
            kind: "found",
            external_id: found.externalId,
            external_url: found.url ?? null,
            response_payload: { key: request.key, external_id: found.externalId, reconciled: true },
          }
        : { kind: "not_found" };
    },
  };
}

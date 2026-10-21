import type { Express, Response } from "express";

import {
  ROOM_TRACKER_FILTER_MAX_LENGTH,
  type RoomTrackerFilterList,
  type RoomTrackerFilterTestResult,
  type TrackerProvider,
} from "../../../../shared/ticket-connectors.mjs";
import { type ConnectionService, connectorErrorText, createConnectionService } from "../../connectors/connections.js";
import { ConnectorDecryptError, loadConnectorCipher } from "../../connectors/crypto.js";
import { createWorkItemProviders, type WorkItemProviders } from "../../connectors/providers/index.js";
import { jiraFilterClause } from "../../connectors/providers/jira.js";
import { parseLinearFilter } from "../../connectors/providers/linear.js";
import { TrackerProviderError } from "../../connectors/providers/types.js";
import {
  deleteRoomTrackerFilter,
  getRoomTrackerFilter,
  listRoomTrackerFilters,
  RoomTrackerFilterProviderTakenError,
  toRoomTrackerFilterView,
  upsertRoomTrackerFilter,
} from "../../connectors/room-filters.js";
import { MAX_ITEMS_PER_POLL } from "../../connectors/sync.js";
import { trackerConnectionStore, type TrackerConnectionRow, type TrackerConnectionStore } from "../../connectors/store.js";
import type { Project } from "../../db.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { normalizeRoomId } from "../../rooms/routing.js";
import { requireAccount } from "../account/connectors/index.js";
import type { RoomMetadataRouteDeps } from "./metadata.js";
import type { RoomMessageRouteDeps } from "./messages/types.js";

const TEST_SAMPLE = 5;

export interface RoomTrackerFilterRouteDeps
  extends Pick<RoomMetadataRouteDeps, "resolveCanonicalRoomRequestId" | "resolveRoomOrReply" | "resolveProjectRole">,
    Pick<RoomMessageRouteDeps, "requireParticipant"> {
  connectors?: {
    store: Pick<TrackerConnectionStore, "get">;
    service: Pick<ConnectionService, "open" | "recordFailure"> | null;
    providers: WorkItemProviders;
  };
}

/** Throws a "definite" TrackerProviderError when the filter is not valid for the tracker. */
function validateFilter(provider: TrackerProvider, filter: string): void {
  if (provider === "jira") jiraFilterClause(filter);
  else parseLinearFilter(filter);
}

/**
 * Room ticket filters (ticket connectors PR3). Any participant may read them.
 * Only a room admin who signed in to the app may add one, and only with a
 * connection they own: a filter imports tickets with the owner's credentials.
 */
export function registerRoomTrackerFilterRoutes(app: Express, deps: RoomTrackerFilterRouteDeps): void {
  const connectors = deps.connectors ?? (() => {
    const cipher = loadConnectorCipher();
    const providers = createWorkItemProviders();
    return {
      store: trackerConnectionStore,
      service: cipher ? createConnectionService({ store: trackerConnectionStore, cipher, providers }) : null,
      providers,
    };
  })();

  async function room(req: AuthenticatedRequest, res: Response): Promise<Project | null> {
    const raw = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(raw));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project || !await deps.requireParticipant(req, res, project)) return null;
    return project;
  }

  /** The signed-in human admin's account, or a reply. */
  async function manager(req: AuthenticatedRequest, res: Response, project: Project): Promise<string | null> {
    const accountId = requireAccount(req, res);
    if (!accountId) return null;
    if (await deps.resolveProjectRole(project, req.sessionAccount) !== "admin") {
      res.status(403).json({ error: "Only a room admin can change ticket filters." });
      return null;
    }
    return accountId;
  }

  async function ownedConnection(res: Response, accountId: string, connectionId: unknown): Promise<TrackerConnectionRow | null> {
    const row = typeof connectionId === "string" && connectionId ? await connectors.store.get(connectionId) : null;
    if (!row || row.account_id !== accountId) {
      res.status(404).json({ error: "Tracker connection not found." });
      return null;
    }
    return row;
  }

  function readFilter(res: Response, provider: TrackerProvider, value: unknown): string | null {
    const filter = typeof value === "string" ? value.trim() : "";
    if (filter.length > ROOM_TRACKER_FILTER_MAX_LENGTH) {
      res.status(400).json({ error: "The filter is too long." });
      return null;
    }
    try {
      validateFilter(provider, filter);
    } catch (error) {
      res.status(400).json({ error: error instanceof TrackerProviderError ? error.message : "The filter is not valid." });
      return null;
    }
    return filter;
  }

  async function list(req: AuthenticatedRequest, project: Project): Promise<RoomTrackerFilterList> {
    const accountId = req.authKind === "session" ? req.sessionAccount?.account_id ?? null : null;
    const role = accountId ? await deps.resolveProjectRole(project, req.sessionAccount) : null;
    const rows = await listRoomTrackerFilters(project.id);
    return {
      filters: rows.map((row) => toRoomTrackerFilterView(row, accountId)),
      can_manage: role === "admin",
    };
  }

  app.get(/^\/rooms\/(.+)\/tracker-filters$/, async (req: AuthenticatedRequest, res) => {
    const project = await room(req, res);
    if (!project) return;
    res.json(await list(req, project));
  });

  /** Add the room's filter for a connection, or replace it. */
  app.put(/^\/rooms\/(.+)\/tracker-filters$/, async (req: AuthenticatedRequest, res) => {
    const project = await room(req, res);
    if (!project) return;
    const accountId = await manager(req, res, project);
    if (!accountId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const connection = await ownedConnection(res, accountId, body.connection_id);
    if (!connection) return;
    const filter = readFilter(res, connection.provider as TrackerProvider, body.filter);
    if (filter === null) return;
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean." });
      return;
    }
    // Cards are matched by `provider:KEY`, so one room reads each tracker
    // through one connection: two would fight over the same cards.
    const other = (await listRoomTrackerFilters(project.id))
      .find((row) => row.provider === connection.provider && row.connection_id !== connection.id);
    if (other) {
      res.status(409).json({
        error: `This room already imports ${other.provider === "jira" ? "Jira" : "Linear"} tickets through ${other.connection_label}. Remove that filter first.`,
        code: "tracker_filter_provider_taken",
      });
      return;
    }
    try {
      await upsertRoomTrackerFilter({
        room_id: project.id,
        connection_id: connection.id,
        provider: connection.provider as TrackerProvider,
        filter,
        enabled: body.enabled !== false,
        account_id: accountId,
      });
    } catch (error) {
      if (!(error instanceof RoomTrackerFilterProviderTakenError)) throw error;
      res.status(409).json({ error: error.message, code: error.code });
      return;
    }
    res.json(await list(req, project));
  });

  app.patch(/^\/rooms\/(.+)\/tracker-filters\/(rtf_[0-9a-f-]{36})$/, async (req: AuthenticatedRequest, res) => {
    const project = await room(req, res);
    if (!project) return;
    const accountId = await manager(req, res, project);
    if (!accountId) return;
    const existing = await getRoomTrackerFilter(project.id, (req.params as Record<string, string>)[1] ?? "");
    if (!existing || existing.connection_account_id !== accountId) {
      res.status(404).json({ error: "Ticket filter not found." });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean." });
      return;
    }
    const filter = body.filter === undefined ? existing.filter : readFilter(res, existing.provider, body.filter);
    if (filter === null) return;
    await upsertRoomTrackerFilter({
      room_id: project.id,
      connection_id: existing.connection_id,
      provider: existing.provider,
      filter,
      enabled: typeof body.enabled === "boolean" ? body.enabled : existing.enabled,
      account_id: accountId,
    });
    res.json(await list(req, project));
  });

  /** A room admin may remove any filter; imported cards stay on the board. */
  app.delete(/^\/rooms\/(.+)\/tracker-filters\/(rtf_[0-9a-f-]{36})$/, async (req: AuthenticatedRequest, res) => {
    const project = await room(req, res);
    if (!project) return;
    if (!await manager(req, res, project)) return;
    const removed = await deleteRoomTrackerFilter(project.id, (req.params as Record<string, string>)[1] ?? "");
    if (!removed) {
      res.status(404).json({ error: "Ticket filter not found." });
      return;
    }
    res.json(await list(req, project));
  });

  /** Count the tickets a filter matches, without saving it. */
  app.post(/^\/rooms\/(.+)\/tracker-filters\/test$/, async (req: AuthenticatedRequest, res) => {
    const project = await room(req, res);
    if (!project) return;
    const accountId = await manager(req, res, project);
    if (!accountId) return;
    if (!connectors.service) {
      res.status(503).json({ error: "Ticket connectors are not configured on this server." });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const connection = await ownedConnection(res, accountId, body.connection_id);
    if (!connection) return;
    const provider = connection.provider as TrackerProvider;
    const filter = readFilter(res, provider, body.filter);
    if (filter === null) return;
    let result: RoomTrackerFilterTestResult;
    try {
      const items = await connectors.providers[provider].listItems(connectors.service.open(connection), filter || null, {
        limit: MAX_ITEMS_PER_POLL,
      });
      result = {
        ok: true,
        count: items.length,
        limit: MAX_ITEMS_PER_POLL,
        sample: items.slice(0, TEST_SAMPLE).map((item) => ({
          key: item.key,
          title: item.title,
          raw_status: item.raw_status,
          ticket_state: item.ticket_state,
          unmapped: item.unmapped,
          url: item.url,
        })),
        error: null,
      };
    } catch (error) {
      const text = error instanceof TrackerProviderError || error instanceof ConnectorDecryptError
        ? await connectors.service.recordFailure(connection, error)
        : connectorErrorText(error);
      result = { ok: false, count: 0, limit: MAX_ITEMS_PER_POLL, sample: [], error: text };
    }
    res.json(result);
  });
}

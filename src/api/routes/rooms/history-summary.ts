import type { Express, Response } from "express";
import {
  ROOM_HISTORY_SUMMARY_NOTE,
  clampRoomHistoryViewLines,
  formatRoomHistoryNodeId,
  type RoomHistoryExpansion,
  type RoomHistorySummarySetting,
  type RoomHistorySummaryState,
  type RoomHistorySummaryView,
} from "../../../../shared/room-history-summary.mjs";
import type { Project } from "../../db.js";
import * as settings from "../../db/room-settings.js";
import * as history from "../../history-summary/store.js";
import { readRoomHistorySummarizer } from "../../history-summary/summarizer.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { isHumanAppWrite } from "../../request/app-session.js";
import type { RoomSettingsRouteDeps } from "./settings.js";
import { replyTurnHoldAgentKey, resolveMessageActivationIdentity } from "./messages/activation-identity.js";
import { resolveParticipantRoom } from "./messages/helpers.js";
import type { RoomMessageRouteDeps } from "./messages/types.js";

export type RoomHistorySummaryRouteDeps = Pick<RoomSettingsRouteDeps,
  "resolveCanonicalRoomRequestId" | "resolveRoomOrReply" | "requireAdmin" | "resolveProjectRole" | "requireParticipant"> & {
  settings?: Pick<typeof settings, "getRoomHistorySummaryEnabled" | "setRoomHistorySummaryEnabled">;
  history?: Pick<typeof history, "startOrWakeRoomHistory" | "skipRoomHistoryToNow" | "readRoomHistoryStatus" | "readRoomHistoryView" | "readRoomHistoryExpansion">;
  summarizerConfigured?: () => boolean;
  /** The worker agent making a read, if any: it sees nothing held for its sequential reply turn. */
  resolveHoldAgentKey?: (req: AuthenticatedRequest, roomId: string) => Promise<string | null>;
};

/**
 * Room history summaries: the admin setting, the view agents and people
 * read, and the expansion of one line into the lines (or message) under it.
 * Reading starts or wakes the room's summary, so a quiet room is summarized
 * once someone needs it.
 */
export function registerRoomHistorySummaryRoutes(app: Express, deps: RoomHistorySummaryRouteDeps): void {
  const store = deps.settings ?? settings;
  const tree = deps.history ?? history;
  const configured = deps.summarizerConfigured ?? (() => readRoomHistorySummarizer() !== null);
  const holdAgentKey = deps.resolveHoldAgentKey
    ?? (async (req: AuthenticatedRequest, roomId: string) => replyTurnHoldAgentKey(await resolveMessageActivationIdentity(req, roomId)));
  const room = (req: AuthenticatedRequest, res: Response) =>
    resolveParticipantRoom(req, res, deps as unknown as RoomMessageRouteDeps);
  const isPerson = (req: AuthenticatedRequest) => isHumanAppWrite(req, req.body ?? {});
  const canManage = async (req: AuthenticatedRequest, project: Project) =>
    isPerson(req) && await deps.resolveProjectRole(project, req.sessionAccount) === "admin";

  function fail(res: Response, error: unknown): void {
    console.error("[room history]", error);
    res.status(500).json({ error: "The room history summary could not be loaded or saved. Please retry." });
  }

  /** "off" and "unavailable" before anything is read; otherwise the stored status, starting the room if needed. */
  async function status(project: Project): Promise<{ enabled: boolean; state: RoomHistorySummaryState } & Omit<history.RoomHistoryStatus, "state">> {
    const enabled = await store.getRoomHistorySummaryEnabled(project.id);
    const idle = { summarized_messages: 0, pending_lines: 0, retry_at: null, last_error: null };
    if (!enabled) return { enabled, state: "off", ...idle };
    if (!configured()) return { enabled, state: "unavailable", ...idle };
    await tree.startOrWakeRoomHistory(project.id);
    return { enabled, ...await tree.readRoomHistoryStatus(project.id) };
  }

  async function settingResponse(req: AuthenticatedRequest, project: Project): Promise<RoomHistorySummarySetting> {
    return { room_id: project.id, ...await status(project), can_manage: await canManage(req, project) };
  }

  app.get(/^\/rooms\/(.+)\/history-summary\/setting$/, async (req: AuthenticatedRequest, res) => {
    try { const project = await room(req, res); if (project) res.json(await settingResponse(req, project)); }
    catch (error) { fail(res, error); }
  });
  app.put(/^\/rooms\/(.+)\/history-summary\/setting$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res);
      if (!project || !await deps.requireAdmin(req, res, project)) return;
      // The setting decides what leaves the server for the summarizer, so
      // an agent may not change it, not even with an admin owner's token.
      if (!isPerson(req)) {
        res.status(403).json({ error: "Room settings can only be changed by a person signed in to LetAgents." });
        return;
      }
      if (typeof req.body?.enabled !== "boolean") { res.status(400).json({ error: "enabled must be a boolean" }); return; }
      const wasEnabled = await store.getRoomHistorySummaryEnabled(project.id);
      await store.setRoomHistorySummaryEnabled(project.id, req.body.enabled);
      // Messages posted while summaries were off never leave the server.
      if (req.body.enabled && !wasEnabled) await tree.skipRoomHistoryToNow(project.id);
      res.json(await settingResponse(req, project));
    } catch (error) { fail(res, error); }
  });

  app.get(/^\/rooms\/(.+)\/history-summary$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res);
      if (!project) return;
      const current = await status(project);
      const view = current.state === "off" || current.state === "unavailable"
        ? { lines: [], omitted_older_lines: 0, covered_through_message_id: null }
        : await tree.readRoomHistoryView(project.id, clampRoomHistoryViewLines(Number(req.query.max_lines ?? Number.NaN)),
          { holdAgentKey: await holdAgentKey(req, project.id) });
      res.json({ room_id: project.id, state: current.state, note: ROOM_HISTORY_SUMMARY_NOTE, ...view } satisfies RoomHistorySummaryView
        & { omitted_older_lines: number });
    } catch (error) { fail(res, error); }
  });

  app.get(/^\/rooms\/(.+)\/history-summary\/nodes\/(\d{1,2}):(\d{1,9})$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res);
      if (!project) return;
      const level = Number(req.params[1]);
      const idx = Number(req.params[2]);
      if (!await store.getRoomHistorySummaryEnabled(project.id)) {
        res.status(409).json({ error: "History summaries are off in this room." });
        return;
      }
      const expansion = await tree.readRoomHistoryExpansion(project.id, level, idx, { holdAgentKey: await holdAgentKey(req, project.id) });
      if (!expansion) { res.status(404).json({ error: "No such history summary line." }); return; }
      res.json({ room_id: project.id, node: formatRoomHistoryNodeId(level, idx), ...expansion } satisfies RoomHistoryExpansion);
    } catch (error) { fail(res, error); }
  });
}

import type { Express, Response } from "express";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { isAppSession } from "../../../request/app-session.js";
import { parseScopedId, formatMessageId } from "../../../db/utils.js";
import { createMessageReminder, deleteMessageReminder, listMessageReminders, loadReminderMessage } from "../../../notifications/reminders.js";
import { getProjectById } from "../../../db.js";
import { resolveProjectRepoRoomAccessDecision } from "../../../rooms/access.js";
import { resolveParticipantRoom, routeParam } from "./helpers.js";
import type { RoomMessageRouteDeps } from "./types.js";

const databaseStore = { create: createMessageReminder, remove: deleteMessageReminder, list: listMessageReminders,
  message: loadReminderMessage, project: getProjectById, access: resolveProjectRepoRoomAccessDecision };
export type MessageReminderStore = typeof databaseStore;
function person(req: AuthenticatedRequest, res: Response): string | null {
  if (isAppSession(req)) return req.sessionAccount!.account_id;
  res.status(req.authKind ? 403 : 401).json({ code: "person_required", error: "Only a signed-in person can manage reminders." });
  return null;
}
function fail(res: Response, error: unknown) {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  if (code === "55P03") { res.status(503).json({ code: "reminder_busy", error: "Reminders are busy. Please retry." }); return; }
  console.error("[message reminders]", error);
  res.status(500).json({ error: "Reminders could not be loaded or saved. Please retry." });
}
function summary(row: Awaited<ReturnType<typeof listMessageReminders>>[number]) {
  return { id: row.id, room_id: row.room_id, message_id: formatMessageId(row.message_number), due_at: row.due_at, state: row.state };
}
export function registerMessageReminderRoutes(app: Express, deps: RoomMessageRouteDeps, store: MessageReminderStore = databaseStore): void {
  app.post(/^\/rooms\/(.+)\/messages\/(msg_[^/]+)\/reminders$/, async (req: AuthenticatedRequest, res) => {
    const accountId = person(req, res); if (!accountId) return;
    try {
      const room = await resolveParticipantRoom(req, res, deps); if (!room) return;
      const number = parseScopedId(routeParam(req, 1), "msg");
      const dueAt = req.body?.due_at;
      if (!number || typeof dueAt !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(dueAt)
        || !Number.isFinite(Date.parse(dueAt)) || Object.keys(req.body ?? {}).some(key => key !== "due_at")) {
        res.status(400).json({ code: "invalid_reminder", error: "Choose a message and an absolute reminder time." }); return;
      }
      const result = await store.create({ accountId, roomId: room.id, messageNumber: number, dueAt: new Date(dueAt).toISOString() });
      if (result.error) {
        res.status(result.error === "message_not_found" ? 404 : result.error === "reminder_limit" ? 409 : 400)
          .json({ code: result.error, error: result.error === "reminder_limit" ? "You can have up to 100 pending reminders." : "Choose a visible message and a future time within 30 days." }); return;
      }
      res.status(201).json({ reminder: summary(result.reminder) });
    } catch (error) { fail(res, error); }
  });
  app.get("/desktop/reminders", async (req: AuthenticatedRequest, res) => {
    const accountId = person(req, res); if (!accountId) return;
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) { res.status(400).json({ error: "Invalid page." }); return; }
    try {
      const rows = await store.list(accountId, offset);
      const access = new Map<string, Promise<boolean>>();
      async function mayPreview(roomId: string): Promise<boolean> {
        const project = await store.project(roomId);
        if (!project) return false;
        // Match ordinary session room reads; fresh checks remain in push delivery.
        const result = await store.access({ project, sessionAccount: req.sessionAccount });
        return result.decision.kind === "allow";
      }
      const reminders = await Promise.all(rows.slice(0, 50).map(async row => {
        let decision = access.get(row.room_id);
        if (!decision) { decision = mayPreview(row.room_id).catch(() => false); access.set(row.room_id, decision); }
        const message = await decision ? await store.message(row.room_id, row.message_number) : null;
        return { ...summary(row), preview: message ? { sender: message.sender, snippet: (message.displayText ?? message.body).slice(0, 300),
          room_display_name: message.roomName, thread_root_id: message.threadRoot === null ? null : formatMessageId(message.threadRoot) } : null };
      }));
      res.json({ reminders, next_offset: rows.length > 50 ? offset + 50 : null });
    } catch (error) { fail(res, error); }
  });
  app.delete("/desktop/reminders/:id", async (req: AuthenticatedRequest, res) => {
    const accountId = person(req, res); if (!accountId) return;
    const id = req.params.id;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: "Invalid reminder." }); return; }
    try { await store.remove(accountId, id); res.json({ ok: true }); }
    catch (error) { fail(res, error); }
  });
}

import type { Express, Response } from "express";

import {
  assignProjectAdmin,
  concludeFocusRoom,
  createFocusRoomFromIntent,
  getFocusRoomByKey,
  getFocusRoomsForParent,
  getTaskById,
  getTaskOwnershipState,
  updateFocusRoomSettings,
  type Project,
  type Task,
} from "../db.js";
import {
  respondWithBadRequest,
  type AuthenticatedRequest,
} from "../http-helpers.js";
import {
  normalizeFocusRoomSettings,
  shouldPostFocusRoomEventToParent,
  validateFocusRoomSettingsPatch,
} from "../focus-room-settings.js";
import { normalizeRoomId } from "../room-routing.js";
import {
  normalizeTaskActorKey,
  normalizeTaskActorLabel,
} from "../task-ownership.js";

type RoomRole = "admin" | "participant" | "anonymous";
type TaskOwnershipState = NonNullable<Awaited<ReturnType<typeof getTaskOwnershipState>>>;

type FocusConclusionGuardDecision =
  | { kind: "allow" }
  | { kind: "deny"; code: string; error: string };

export interface RoomFocusRouteDeps {
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  resolveRoomOrReply(
    roomId: string,
    res: Response,
    options?: { allowCreate: boolean }
  ): Promise<Project | null>;
  requireParticipant(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
  resolveProjectRole(
    project: Project,
    sessionAccount: AuthenticatedRequest["sessionAccount"]
  ): Promise<RoomRole>;
  toRoomResponse(
    project: Project,
    options?: {
      role?: RoomRole;
      authenticated?: boolean;
    }
  ): Record<string, unknown>;
  normalizeOptionalString(value: unknown): string | null;
  enforceFocusRoomConclusion(input: {
    req: AuthenticatedRequest;
    projectId: string;
    task: Task;
    taskOwnership: TaskOwnershipState;
    actorLabel: string | null;
    actorKey: string | null;
    actorInstanceId: string | null;
  }): Promise<FocusConclusionGuardDecision>;
  emitProjectMessage(projectId: string, sender: string, text: string): Promise<unknown>;
  formatFocusRoomConclusionMessage(input: {
    focusRoom: Project;
    task?: Task;
    summary: string;
  }): string;
}

export function registerRoomFocusRoutes(
  app: Express,
  deps: RoomFocusRouteDeps
): void {
  app.get(/^\/rooms\/(.+)\/focus\/([^/]+)$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const focusKey = decodeURIComponent((req.params as Record<string, string>)[1] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const focusRoom = await getFocusRoomByKey(project.id, focusKey);
    if (!focusRoom) {
      res.status(404).json({ error: "Focus Room not found", code: "ROOM_NOT_FOUND" });
      return;
    }

    const role = await deps.resolveProjectRole(focusRoom, req.sessionAccount);
    res.json({
      ...deps.toRoomResponse(focusRoom, {
        role,
        authenticated: Boolean(req.sessionAccount),
      }),
    });
  });

  app.patch(/^\/rooms\/(.+)\/focus\/([^/]+)\/settings$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const focusKey = decodeURIComponent((req.params as Record<string, string>)[1] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res, { allowCreate: false });
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    try {
      const settings = validateFocusRoomSettingsPatch(req.body ?? {});
      const focusRoom = await updateFocusRoomSettings(project.id, focusKey, settings);
      if (!focusRoom) {
        res.status(404).json({ error: "Focus Room not found", code: "ROOM_NOT_FOUND" });
        return;
      }

      const role = await deps.resolveProjectRole(focusRoom, req.sessionAccount);
      res.json({
        room_id: project.id,
        focus_key: focusKey,
        focus_room: deps.toRoomResponse(focusRoom, {
          role,
          authenticated: Boolean(req.sessionAccount),
        }),
      });
    } catch (error) {
      respondWithBadRequest(
        res,
        "PATCH /rooms/:room_id/focus/:focus_key/settings",
        error,
        "Focus Room settings could not be updated."
      );
    }
  });

  app.get(/^\/rooms\/(.+)\/focus-rooms$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const focusRooms = await getFocusRoomsForParent(project.id);
    res.json({
      room_id: project.id,
      focus_rooms: focusRooms.map((focusRoom) => deps.toRoomResponse(focusRoom)),
    });
  });

  app.post(/^\/rooms\/(.+)\/focus-rooms$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res, { allowCreate: false });
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const requestBody = (req.body ?? {}) as Record<string, unknown>;
    const { title, display_name } = requestBody as {
      title?: unknown;
      display_name?: string;
    };
    if (typeof title !== "string" || !title.trim()) {
      res.status(400).json({ error: "title is required" });
      return;
    }

    try {
      const result = await createFocusRoomFromIntent(project.id, title, {
        displayName: display_name,
      });

      if (req.sessionAccount) {
        await assignProjectAdmin(result.room.id, req.sessionAccount.account_id);
      }

      await deps.emitProjectMessage(
        project.id,
        "letagents",
        `[status] Focus Room opened: ${result.room.display_name}`
      );

      const role = await deps.resolveProjectRole(result.room, req.sessionAccount);
      res.status(201).json({
        room_id: project.id,
        created: result.created,
        focus_room: deps.toRoomResponse(result.room, {
          role,
          authenticated: Boolean(req.sessionAccount),
        }),
      });
    } catch (error) {
      respondWithBadRequest(
        res,
        "POST /rooms/:room_id/focus-rooms",
        error,
        "Focus Room could not be opened."
      );
    }
  });

  app.post(/^\/rooms\/(.+)\/focus\/([^/]+)\/conclude$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const focusKey = decodeURIComponent((req.params as Record<string, string>)[1] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res, { allowCreate: false });
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const requestBody = (req.body ?? {}) as Record<string, unknown>;
    const { summary } = requestBody as { summary?: unknown };
    if (typeof summary !== "string" || !summary.trim()) {
      res.status(400).json({ error: "summary is required" });
      return;
    }

    try {
      const focusRoom = await getFocusRoomByKey(project.id, focusKey);
      if (!focusRoom) {
        res.status(404).json({ error: "Focus Room not found", code: "ROOM_NOT_FOUND" });
        return;
      }

      if (focusRoom.source_task_id) {
        const task = await getTaskById(project.id, focusRoom.source_task_id);
        const taskOwnership = await getTaskOwnershipState(project.id, focusRoom.source_task_id);
        if (task && taskOwnership) {
          const coordination = await deps.enforceFocusRoomConclusion({
            req,
            projectId: project.id,
            task,
            taskOwnership,
            actorLabel: normalizeTaskActorLabel(requestBody.actor_label),
            actorKey: normalizeTaskActorKey(requestBody.actor_key),
            actorInstanceId: deps.normalizeOptionalString(requestBody.actor_instance_id),
          });
          if (coordination.kind === "deny") {
            res.status(409).json({ error: coordination.error, code: coordination.code });
            return;
          }
        }
      }

      const result = await concludeFocusRoom(project.id, focusKey, summary);
      if (!result) {
        res.status(404).json({ error: "Focus Room not found", code: "ROOM_NOT_FOUND" });
        return;
      }

      const shouldPostResultToParent = shouldPostFocusRoomEventToParent(
        normalizeFocusRoomSettings({
          parent_visibility: result.room.focus_parent_visibility,
          activity_scope: result.room.focus_activity_scope,
          github_event_routing: result.room.focus_github_event_routing,
        }),
        "result_summary"
      );
      const message = result.updated && shouldPostResultToParent
        ? await deps.emitProjectMessage(
            project.id,
            "letagents",
            deps.formatFocusRoomConclusionMessage({
              focusRoom: result.room,
              task: result.task,
              summary: result.room.conclusion_summary || summary.trim(),
            })
          )
        : null;

      const role = await deps.resolveProjectRole(result.room, req.sessionAccount);
      res.json({
        room_id: project.id,
        focus_key: focusKey,
        shared: result.updated,
        message,
        focus_room: deps.toRoomResponse(result.room, {
          role,
          authenticated: Boolean(req.sessionAccount),
        }),
      });
    } catch (error) {
      respondWithBadRequest(
        res,
        "POST /rooms/:room_id/focus/:focus_key/conclude",
        error,
        "Focus Room result could not be shared."
      );
    }
  });
}

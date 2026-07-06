import type { Express, Response } from "express";
import type { EventEmitter } from "node:events";

import type { Project, RoomSharedArtifact } from "../../db.js";
import type {
  AuthenticatedRequest,
} from "../../http/helpers.js";
import { respondWithBadRequest } from "../../http/helpers.js";
import type { WorkerRequestAgentIdentityResult } from "../../request/agent-identity.js";
import {
  validateTaskWorkflowArtifactsInput,
  type TaskWorkflowArtifact,
} from "../../repo-workflow.js";
import { normalizeRoomId } from "../../rooms/routing.js";

export type PublishedArtifactSource = "manual" | "task_workflow_artifact";

export interface RoomArtifactRouteDeps {
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  resolveRoomOrReply(roomId: string, res: Response): Promise<Project | null>;
  requireParticipant(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
  getRoomSharedArtifacts(input: {
    room_id: string;
    task_id?: string | null;
    limit?: number;
  }): Promise<RoomSharedArtifact[]>;
  upsertRoomSharedArtifact(input: {
    room_id: string;
    artifact: TaskWorkflowArtifact;
    source?: PublishedArtifactSource;
  }): Promise<RoomSharedArtifact>;
  linkRoomSharedArtifactToTask(input: {
    room_id: string;
    artifact_identity_key: string;
    task_id: string;
    source?: PublishedArtifactSource;
  }): Promise<unknown>;
  requireWorkerRequestAgentIdentity(input: {
    req: AuthenticatedRequest;
    body: Record<string, unknown>;
    room_id: string;
  }): Promise<WorkerRequestAgentIdentityResult>;
  getRoomSharedArtifactByIdentityKey(input: {
    room_id: string;
    identity_key: string;
  }): Promise<RoomSharedArtifact | null>;
  artifactEvents?: EventEmitter;
}

function parseOptionalTaskId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function parseArtifactLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeOptionalArtifactString(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizePublishedArtifact(artifact: TaskWorkflowArtifact): TaskWorkflowArtifact {
  return {
    provider: artifact.provider,
    kind: artifact.kind,
    ...(artifact.id !== undefined ? { id: normalizeOptionalArtifactString(artifact.id) } : {}),
    ...(artifact.number !== undefined ? { number: artifact.number } : {}),
    ...(artifact.title !== undefined ? { title: normalizeOptionalArtifactString(artifact.title) } : {}),
    ...(artifact.url !== undefined ? { url: normalizeOptionalArtifactString(artifact.url) } : {}),
    ...(artifact.ref !== undefined ? { ref: normalizeOptionalArtifactString(artifact.ref) } : {}),
    ...(artifact.state !== undefined ? { state: normalizeOptionalArtifactString(artifact.state) } : {}),
  };
}

function artifactHasStableIdentity(artifact: TaskWorkflowArtifact): boolean {
  return Boolean(
    artifact.url ||
      artifact.id ||
      artifact.number !== undefined && artifact.number !== null ||
      artifact.ref
  );
}

function artifactInputFromBody(body: Record<string, unknown>): unknown {
  if (body.artifact && typeof body.artifact === "object" && !Array.isArray(body.artifact)) {
    return body.artifact;
  }

  return {
    provider: body.provider,
    kind: body.kind,
    id: body.id,
    number: body.number,
    title: body.title,
    url: body.url,
    ref: body.ref,
    state: body.state,
  };
}

function parsePublishedArtifact(body: Record<string, unknown>): TaskWorkflowArtifact {
  const artifacts = validateTaskWorkflowArtifactsInput([artifactInputFromBody(body)]);
  const artifact = normalizePublishedArtifact(artifacts?.[0] as TaskWorkflowArtifact);
  if (!artifactHasStableIdentity(artifact)) {
    throw new Error("artifact requires at least one stable identity: url, id, number, or ref");
  }
  return artifact;
}

function hasAgentSessionCredentials(body: Record<string, unknown>): boolean {
  return (typeof body.agent_session_id === "string" && body.agent_session_id.trim().length > 0)
    || (typeof body.agent_session_token === "string" && body.agent_session_token.trim().length > 0);
}

function parseLinkedTaskIds(body: Record<string, unknown>): string[] {
  const taskIds = new Set<string>();

  const addTaskId = (value: unknown, field: string) => {
    if (value === undefined || value === null || value === "") return;
    if (typeof value !== "string") {
      throw new Error(`${field} must be a string`);
    }
    const trimmed = value.trim();
    if (trimmed) taskIds.add(trimmed);
  };

  addTaskId(body.task_id, "task_id");

  if (body.linked_task_ids !== undefined) {
    if (!Array.isArray(body.linked_task_ids)) {
      throw new Error("linked_task_ids must be an array");
    }
    if (body.linked_task_ids.length > 32) {
      throw new Error("linked_task_ids cannot contain more than 32 entries");
    }
    for (const taskId of body.linked_task_ids) {
      addTaskId(taskId, "linked_task_ids");
    }
  }

  return [...taskIds];
}

export function registerRoomArtifactRoutes(
  app: Express,
  deps: RoomArtifactRouteDeps
): void {
  app.get(/^\/rooms\/(.+)\/artifacts$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const artifacts = await deps.getRoomSharedArtifacts({
      room_id: project.id,
      task_id: parseOptionalTaskId(req.query.task_id),
      limit: parseArtifactLimit(req.query.limit),
    });

    res.json({
      room_id: project.id,
      artifacts,
    });
  });

  app.post(/^\/rooms\/(.+)\/artifacts$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    // Agent sessions publish workflow artifacts, humans publish manual ones.
    // Presenting credentials means the caller claims to be an agent, so bad
    // credentials are an error rather than a silent downgrade to manual.
    let source: PublishedArtifactSource = "manual";
    if (req.authKind === "owner_token" && hasAgentSessionCredentials(body)) {
      const worker = await deps.requireWorkerRequestAgentIdentity({
        req,
        body,
        room_id: project.id,
      });
      if (!worker.ok) {
        res.status(worker.status).json({ error: worker.error });
        return;
      }
      source = "task_workflow_artifact";
    }

    try {
      const artifact = parsePublishedArtifact(body);
      const linkedTaskIds = parseLinkedTaskIds(body);
      const sharedArtifact = await deps.upsertRoomSharedArtifact({
        room_id: project.id,
        artifact,
        source,
      });

      for (const taskId of linkedTaskIds) {
        await deps.linkRoomSharedArtifactToTask({
          room_id: project.id,
          artifact_identity_key: sharedArtifact.identity_key,
          task_id: taskId,
          source,
        });
      }

      const hydratedArtifact = await deps.getRoomSharedArtifactByIdentityKey({
        room_id: project.id,
        identity_key: sharedArtifact.identity_key,
      });
      deps.artifactEvents?.emit("artifact:updated", {
        projectId: project.id,
        artifact: hydratedArtifact ?? sharedArtifact,
      });

      res.json({
        room_id: project.id,
        artifact: hydratedArtifact ?? {
          ...sharedArtifact,
          linked_task_ids: linkedTaskIds,
        },
      });
    } catch (error) {
      respondWithBadRequest(
        res,
        "POST /rooms/:room_id/artifacts",
        error,
        "Artifact could not be published."
      );
    }
  });
}

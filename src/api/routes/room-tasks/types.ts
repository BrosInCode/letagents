import type { EventEmitter } from "events";
import type { Response } from "express";

import type { Project, Task, TaskLeaseKind, TaskStatus, getTaskOwnershipState } from "../../db.js";
import type { FocusParentBoardWriteIsolationDecision } from "../../focus-room-task-write-isolation.js";
import type { AuthenticatedRequest } from "../../http-helpers.js";
import type { buildTaskUpdatePatch } from "../../task-ownership.js";

export type RoomRole = "admin" | "participant" | "anonymous";
export type TaskUpdatePatch = ReturnType<typeof buildTaskUpdatePatch>["updates"];
export type TaskOwnershipState = NonNullable<Awaited<ReturnType<typeof getTaskOwnershipState>>>;

export type TaskCoordinationGuardDecision =
  | { kind: "allow" }
  | { kind: "deny"; code: string; error: string };

export type TaskAdmissionGuardDecision =
  | { kind: "allow" }
  | { kind: "deny"; code: string; error: string };

export interface RoomTaskRouteDeps {
  taskEvents: EventEmitter;
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  resolveRoomOrReply(
    roomId: string,
    res: Response,
    options?: { allowCreate: boolean }
  ): Promise<Project | null>;
  requireAdmin(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
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
  enforceTaskAdmissionCoordination(input: {
    req: AuthenticatedRequest;
    projectId: string;
    title: string;
    sourceMessageId?: string | null;
    actorLabel: string | null;
    actorKey: string | null;
    actorInstanceId: string | null;
    actorSessionId: string | null;
  }): Promise<TaskAdmissionGuardDecision>;
  isTrustedAgentCreator(projectId: string, createdBy: string): Promise<boolean>;
  emitTaskLifecycleStatusMessage(
    projectId: string,
    task: {
      id: string;
      title: string;
      status: TaskStatus;
      assignee: string | null;
    }
  ): Promise<unknown>;
  validateOwnerTokenTaskActorKey(input: {
    req: AuthenticatedRequest;
    actorKey: string | null;
  }): Promise<{ actorKey: string | null; error: string | null }>;
  enforceTaskCoordinationMutation(input: {
    req: AuthenticatedRequest;
    projectId: string;
    task: Task;
    taskOwnership: TaskOwnershipState;
    updates: TaskUpdatePatch;
    forcedMutation?: { mutation: "focus_room_open" | "task_update"; leaseKind: TaskLeaseKind };
    actorLabel: string | null;
    actorKey: string | null;
    actorInstanceId: string | null;
    actorSessionId: string | null;
  }): Promise<TaskCoordinationGuardDecision>;
  enforceFocusParentBoardWriteIsolation(input: {
    req: AuthenticatedRequest;
    targetProject: Project;
  }): Promise<FocusParentBoardWriteIsolationDecision>;
  emitProjectMessage(projectId: string, sender: string, text: string): Promise<unknown>;
}

import type { Express, Response } from "express";

import {
  assignProjectAdmin,
  createProject,
  getAgentIdentitiesForOwner,
  getAllProjects,
  getOrCreateCanonicalRoom,
  getProjectByCode,
  getProjectById,
  registerAgentIdentity,
  rotateProjectCode,
  type Project,
} from "../db.js";
import {
  type AuthenticatedRequest,
  type ResolvedRequestAuth,
} from "../http-helpers.js";
import { isInviteCode, normalizeRoomId } from "../room-routing.js";

export interface LegacyProjectRouteDeps {
  resolveRequestAuth(req: AuthenticatedRequest): Promise<ResolvedRequestAuth>;
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  isRepoBackedRoomId(roomId: string): boolean;
  isRepoBackedProject(project: Project): boolean;
  resolveRepoRoomAccessDecision(input: {
    roomName: string;
    sessionAccount: AuthenticatedRequest["sessionAccount"];
  }): Promise<{ kind: "allow" } | { kind: "auth_required" } | { kind: "private_repo_no_access" }>;
  replyRepoRoomAccessDecision(
    res: Response,
    roomName: string,
    decision: { kind: "auth_required" } | { kind: "private_repo_no_access" }
  ): false;
  resolveProjectRole(
    project: Project,
    sessionAccount: AuthenticatedRequest["sessionAccount"]
  ): Promise<"admin" | "participant" | "anonymous">;
  requireAdmin(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
  rememberHumanRoomParticipant(input: {
    projectId: string;
    sessionAccount: NonNullable<AuthenticatedRequest["sessionAccount"]>;
  }): Promise<void>;
}

export function registerLegacyProjectRoutes(
  app: Express,
  deps: LegacyProjectRouteDeps
): void {
  app.get("/projects", async (req: AuthenticatedRequest, res) => {
    const { account } = await deps.resolveRequestAuth(req);
    if (!account) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const projects = await getAllProjects();
    // Exclude invite-only rooms; their IDs are their join codes.
    const safeProjects = projects
      .filter(({ id }) => !isInviteCode(id))
      .map(({ id, display_name }) => ({ id, display_name }));
    res.json({ projects: safeProjects });
  });

  app.post("/projects", async (req: AuthenticatedRequest, res) => {
    const project = await createProject();
    if (req.sessionAccount) {
      await assignProjectAdmin(project.id, req.sessionAccount.account_id);
    }
    res.status(201).json(project);
  });

  app.get("/projects/join/:code", async (req, res) => {
    const code = normalizeRoomId(req.params.code);
    const project = await getProjectByCode(code);

    if (!project) {
      res.status(404).json({ error: "Project not found for the given code" });
      return;
    }

    res.json({
      id: project.id,
      code: project.code,
      name: project.name,
      display_name: project.display_name,
    });
  });

  app.post("/projects/room/:name", async (req: AuthenticatedRequest, res) => {
    const name = decodeURIComponent(String(req.params.name));
    const requestedRoomId = normalizeRoomId(name);
    const roomId = await deps.resolveCanonicalRoomRequestId(requestedRoomId);

    if (deps.isRepoBackedRoomId(roomId)) {
      const decision = await deps.resolveRepoRoomAccessDecision({
        roomName: roomId,
        sessionAccount: req.sessionAccount,
      });
      if (decision.kind !== "allow") {
        deps.replyRepoRoomAccessDecision(res, roomId, decision);
        return;
      }
    }

    const { room: project, created } = await getOrCreateCanonicalRoom(roomId);

    if (req.sessionAccount && created) {
      if (deps.isRepoBackedProject(project)) {
        await deps.resolveProjectRole(project, req.sessionAccount);
      } else {
        await assignProjectAdmin(project.id, req.sessionAccount.account_id);
      }
    }

    if (req.sessionAccount) {
      await deps.rememberHumanRoomParticipant({
        projectId: project.id,
        sessionAccount: req.sessionAccount,
      });
    }

    res.status(created ? 201 : 200).json({
      id: project.id,
      code: project.code,
      name: project.name,
      display_name: project.display_name,
    });
  });

  app.get("/projects/:id/access", async (req: AuthenticatedRequest, res) => {
    const projectId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
    const project = await getProjectById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const role = await deps.resolveProjectRole(project, req.sessionAccount);
    res.json({
      project_id: project.id,
      room_type: deps.isRepoBackedProject(project) ? "discoverable" : "invite",
      authenticated: Boolean(req.sessionAccount),
      role,
      account: req.sessionAccount
        ? {
            id: req.sessionAccount.account_id,
            login: req.sessionAccount.login,
            provider: req.sessionAccount.provider,
          }
        : null,
    });
  });

  app.post("/projects/:id/code/rotate", async (req: AuthenticatedRequest, res) => {
    const projectId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
    const project = await getProjectById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (!(await deps.requireAdmin(req, res, project))) {
      return;
    }

    if (!project.code) {
      res.status(400).json({ error: "Only invite rooms can rotate codes" });
      return;
    }

    const rotated = await rotateProjectCode(project.id);
    if (!rotated) {
      res.status(500).json({ error: "Failed to rotate invite code" });
      return;
    }

    res.json({
      id: rotated.id,
      code: rotated.code,
      name: rotated.name,
      display_name: rotated.display_name,
    });
  });

  app.get("/agents/me", async (req: AuthenticatedRequest, res) => {
    if (!req.sessionAccount) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    res.json({
      account: {
        id: req.sessionAccount.account_id,
        login: req.sessionAccount.login,
        display_name: req.sessionAccount.display_name ?? null,
      },
      agents: await getAgentIdentitiesForOwner(req.sessionAccount.account_id),
    });
  });

  app.post("/agents", async (req: AuthenticatedRequest, res) => {
    if (!req.sessionAccount) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const { name, display_name, owner_label } = req.body as {
      name?: string;
      display_name?: string;
      owner_label?: string;
    };

    if (!name?.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const identity = await registerAgentIdentity({
      owner_account_id: req.sessionAccount.account_id,
      owner_login: req.sessionAccount.login,
      owner_label: owner_label?.trim() || req.sessionAccount.display_name || req.sessionAccount.login,
      name: name.trim(),
      display_name: display_name?.trim(),
    });

    res.status(201).json(identity);
  });
}

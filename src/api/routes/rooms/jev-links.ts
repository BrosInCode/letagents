import type { Express, Response } from "express";
import type { EventEmitter } from "node:events";

import type { BoardIntent, Project } from "../../db.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { JevLinkDecisionError, type JevLinkService } from "../../connectors/jev-link.js";
import { normalizeRoomId } from "../../rooms/routing.js";

export type JevLinkDecisions = Pick<JevLinkService, "approveIntent" | "denyIntent" | "acceptLink" | "rejectLink">;

export interface JevLinkRouteDeps {
  taskEvents?: EventEmitter;
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  resolveRoomOrReply(roomId: string, res: Response, options?: { allowCreate: boolean }): Promise<Project | null>;
  requireAdmin(req: AuthenticatedRequest, res: Response, project: Project): Promise<boolean>;
  jevLinks?: () => Promise<JevLinkDecisions>;
}

async function defaultJevLinks(): Promise<JevLinkDecisions> {
  const { getDefaultJevLinkService } = await import("../../connectors/jev/runtime.js");
  return getDefaultJevLinkService();
}

/**
 * A Jev link is confirmed, or its tracker write approved, only by a person
 * signed in to the app (invariant 5): never an agent's owner token, a worker
 * session, or the Board Manager. The caller has checked room admin.
 */
export function requireJevLinkPerson(req: AuthenticatedRequest, res: Response, workerIdentity: unknown): boolean {
  if (workerIdentity || req.authKind !== "session" || !req.sessionAccount) {
    res.status(403).json({
      error: "A person signed in to the LetAgents app must decide a Jev link. Agents and the Board Manager cannot.",
      code: "jev_link_person_required",
    });
    return false;
  }
  return true;
}

function respondToDecisionError(res: Response, error: unknown): boolean {
  if (!(error instanceof JevLinkDecisionError)) return false;
  const status = error.code === "not_found" || error.code === "not_suggested" ? 404 : error.code === "invalid_intent" ? 400 : 409;
  res.status(status).json({ error: error.message, code: `jev_link_${error.code}` });
  return true;
}

/** Approve or deny a "Move KEY?" intent; the board intent routes hand these over. */
export async function respondToJevLinkIntentDecision(input: {
  req: AuthenticatedRequest;
  res: Response;
  project: Project;
  intent: BoardIntent;
  decision: "approve" | "deny";
  decisionBy: string;
  reason: string | null;
  workerIdentity: unknown;
  deps: Pick<JevLinkRouteDeps, "jevLinks" | "taskEvents">;
}): Promise<void> {
  if (!requireJevLinkPerson(input.req, input.res, input.workerIdentity)) return;
  const service = await (input.deps.jevLinks ?? defaultJevLinks)();
  try {
    if (input.decision === "approve") {
      const result = await service.approveIntent({ intent: input.intent, decisionBy: input.decisionBy, reason: input.reason });
      input.deps.taskEvents?.emit("task:updated", { projectId: input.project.id, task: result.task });
      input.res.json({
        room_id: input.project.id,
        intent: result.intent,
        result: { kind: "tracker_jev_link_confirmed", task: result.task, run: result.run },
      });
      return;
    }
    const result = await service.denyIntent({ intent: input.intent, decisionBy: input.decisionBy, reason: input.reason });
    input.res.json({ room_id: input.project.id, intent: result.intent, result: { kind: "tracker_jev_link_denied", detached: result.detached } });
  } catch (error) {
    if (respondToDecisionError(input.res, error)) return;
    throw error;
  }
}

/**
 * Accept or Reject on a card's Jev suggestion:
 * `POST /rooms/:room/tasks/:task/jev-link/accept|reject` with `{ "pr_url": "..." }`.
 * A room admin, signed in to the app.
 */
export function registerJevLinkRoutes(app: Express, deps: JevLinkRouteDeps): void {
  app.post(/^\/rooms\/(.+)\/tasks\/([^/]+)\/jev-link\/(accept|reject)$/, async (req: AuthenticatedRequest, res) => {
    const params = req.params as Record<string, string>;
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(decodeURIComponent(params[0] ?? "")));
    const taskId = params[1] ?? "";
    const action = params[2] as "accept" | "reject";
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    if (!(await deps.requireAdmin(req, res, project))) return;
    if (!requireJevLinkPerson(req, res, null)) return;
    const prUrl = (req.body as Record<string, unknown> | null)?.pr_url;
    if (typeof prUrl !== "string" || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d{1,10}$/.test(prUrl)) {
      res.status(400).json({ error: "pr_url must be a GitHub pull request URL." });
      return;
    }
    const service = await (deps.jevLinks ?? defaultJevLinks)();
    try {
      const decidedBy = req.sessionAccount?.login ?? "admin";
      const task = action === "accept"
        ? await service.acceptLink({ roomId: project.id, taskId, prUrl })
        : await service.rejectLink({ roomId: project.id, taskId, prUrl, decidedBy });
      deps.taskEvents?.emit("task:updated", { projectId: project.id, task });
      res.json({ room_id: project.id, task });
    } catch (error) {
      if (respondToDecisionError(res, error)) return;
      throw error;
    }
  });
}

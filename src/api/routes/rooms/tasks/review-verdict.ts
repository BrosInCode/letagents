import type { Express } from "express";

import {
  getActiveTaskLeases,
  getGitHubAppInstallationById,
  getGitHubAppRepositoryByRoomId,
  getTaskById,
  WorkflowEffectIdempotencyConflictError,
  WorkflowEffectLeaseStaleError,
} from "../../../db.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { getProjectAccessRoomId, isRepoBackedRoomId } from "../../../rooms/access.js";
import { normalizeRoomId } from "../../../rooms/routing.js";
import { workflowEffectBroker } from "../../../workflow-effects/runtime.js";
import type { GitHubReviewVerdict } from "../../../workflow-effects/github-review-provider.js";
import { resolveOwnerTokenWorkerWriteIdentity } from "./request-identity.js";
import type { RoomTaskRouteDeps } from "./types.js";

type ReviewVerdictBody = {
  verdict?: unknown;
  body?: unknown;
  idempotency_key?: unknown;
  expected_head_sha?: unknown;
};

export function normalizeExpectedHeadSha(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(normalized) ? normalized : null;
}

function parsePullRequestUrl(value: string): { owner: string; repo: string; number: number } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    if (!match) return null;
    const number = Number(match[3]);
    return Number.isSafeInteger(number) && number > 0
      ? { owner: match[1], repo: match[2], number }
      : null;
  } catch {
    return null;
  }
}

export function registerTaskReviewVerdictRoute(app: Express, deps: RoomTaskRouteDeps): void {
  app.post(/^\/rooms\/(.+)\/tasks\/([^/]+)\/review-verdict$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const taskId = (req.params as Record<string, string>)[1] ?? "";
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    if (!(await deps.requireParticipant(req, res, project))) return;

    const requestBody = (req.body ?? {}) as ReviewVerdictBody & Record<string, unknown>;
    const worker = await resolveOwnerTokenWorkerWriteIdentity({
      req,
      res,
      room_id: project.id,
      body: requestBody,
    });
    if (worker.kind === "responded") return;
    if (worker.kind !== "worker") {
      res.status(403).json({
        error: "Registered worker session is required to submit a review verdict.",
        code: "coordination_worker_required",
      });
      return;
    }

    const rawVerdict = typeof requestBody.verdict === "string"
      ? requestBody.verdict.trim().toLowerCase()
      : "";
    if (!(["approve", "request_changes", "comment"] as string[]).includes(rawVerdict)) {
      res.status(400).json({ error: "verdict must be one of: approve, request_changes, comment" });
      return;
    }
    const verdict = rawVerdict as GitHubReviewVerdict;
    const body = typeof requestBody.body === "string" ? requestBody.body : "";
    if (body.length > 65_536) {
      res.status(400).json({ error: "body must be at most 65536 characters" });
      return;
    }
    const idempotencyKey = typeof requestBody.idempotency_key === "string"
      ? requestBody.idempotency_key.trim()
      : "";
    if (!idempotencyKey || idempotencyKey.length > 200) {
      res.status(400).json({ error: "idempotency_key is required and must be at most 200 characters" });
      return;
    }
    const expectedHeadSha = normalizeExpectedHeadSha(requestBody.expected_head_sha);
    if (!expectedHeadSha) {
      res.status(400).json({
        error: "expected_head_sha is required and must be an exact 40-hex commit SHA",
        code: "workflow_effect_invalid_head_sha",
      });
      return;
    }

    const task = await getTaskById(project.id, taskId);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (task.status !== "in_review") {
      res.status(409).json({
        error: `Review verdicts require an in_review task; ${task.id} is ${task.status}.`,
        code: "coordination_invalid_task_status",
      });
      return;
    }
    const pull = task.pr_url ? parsePullRequestUrl(task.pr_url) : null;
    if (!pull) {
      res.status(409).json({
        error: "Task must have a canonical GitHub pull request URL before a verdict can be submitted.",
        code: "workflow_effect_pull_request_required",
      });
      return;
    }

    const accessRoomId = getProjectAccessRoomId(project);
    let repoRoomName = isRepoBackedRoomId(accessRoomId) ? accessRoomId : null;
    if (!repoRoomName && deps.getGitRoomBindingForRoom) {
      const binding = await deps.getGitRoomBindingForRoom(accessRoomId)
        ?? (accessRoomId === project.id ? null : await deps.getGitRoomBindingForRoom(project.id));
      if (binding?.provider === "github") {
        repoRoomName = `${binding.host}/${binding.repository_full_name}`;
      }
    }
    if (!repoRoomName) {
      res.status(409).json({
        error: "Review verdict effects require a GitHub-backed room.",
        code: "workflow_effect_github_room_required",
      });
      return;
    }
    const repository = await getGitHubAppRepositoryByRoomId(repoRoomName);
    if (
      !repository
      || repository.removed_at
      || repository.owner_login.toLowerCase() !== pull.owner.toLowerCase()
      || repository.repo_name.toLowerCase() !== pull.repo.toLowerCase()
    ) {
      res.status(409).json({
        error: "The task pull request is not backed by the room's active GitHub App repository.",
        code: "workflow_effect_repository_mismatch",
      });
      return;
    }
    const installation = await getGitHubAppInstallationById(repository.installation_id);
    if (!installation || installation.uninstalled_at || installation.suspended_at) {
      res.status(409).json({
        error: "The room's GitHub App installation is not active.",
        code: "workflow_effect_installation_inactive",
      });
      return;
    }

    const agentSessionId = worker.identity.agent_session_id;
    if (!agentSessionId) {
      res.status(403).json({
        error: "A registered worker agent_session_id is required to submit a review verdict.",
        code: "coordination_worker_session_required",
      });
      return;
    }
    const leases = await getActiveTaskLeases(project.id, task.id);
    const reviewLease = leases.find((lease) =>
      lease.kind === "review"
      && lease.status === "active"
      && lease.agent_key === worker.identity.agent_key
      && lease.agent_session_id === agentSessionId
    );
    if (!reviewLease) {
      res.status(409).json({
        error: "An active review lease held by this exact worker session is required.",
        code: "coordination_review_lease_required",
      });
      return;
    }

    try {
      const effect = await workflowEffectBroker.submitGitHubReviewVerdict({
        room_id: project.id,
        task_id: task.id,
        lease_id: reviewLease.id,
        lease_epoch: reviewLease.epoch,
        agent_key: worker.identity.agent_key,
        agent_session_id: agentSessionId,
        actor_label: worker.identity.actor_label,
        idempotency_key: idempotencyKey,
        owner: repository.owner_login,
        repo: repository.repo_name,
        pull_number: pull.number,
        expected_head_sha: expectedHeadSha,
        installation_id: repository.installation_id,
        verdict,
        body,
      });
      res.status(effect.state === "succeeded" ? 200 : 202).json({
        room_id: project.id,
        task_id: task.id,
        effect: {
          id: effect.id,
          state: effect.state,
          correlation_key: effect.correlation_key,
          attempt_count: effect.attempt_count,
          external_id: effect.external_id,
          external_url: effect.external_url,
          last_error: effect.last_error,
          quarantined_at: effect.quarantined_at,
          quarantine_reason: effect.quarantine_reason,
        },
      });
    } catch (error) {
      if (error instanceof WorkflowEffectIdempotencyConflictError) {
        res.status(409).json({ error: error.message, code: error.code });
        return;
      }
      if (error instanceof WorkflowEffectLeaseStaleError) {
        res.status(409).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  });
}

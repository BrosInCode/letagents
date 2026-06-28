import type { GitHubWebhookPayload } from "../app.js";
import { buildDeliveryScopedKey, normalizeGitHubTimestamp } from "./helpers.js";
import type {
  GitHubRepoEventBase,
  MaterializedGitHubRoomEvent,
} from "./types.js";

const SUPPORTED_CHECK_RUN_ACTIONS = new Set(["completed"]);

export function materializeCheckRunEvent(
  payload: GitHubWebhookPayload,
  action: string,
  deliveryId: string,
  actorLogin: string | null,
  repoIdentity: string,
  base: GitHubRepoEventBase,
): MaterializedGitHubRoomEvent | null {
  if (!SUPPORTED_CHECK_RUN_ACTIONS.has(action) || !payload.check_run) {
    return null;
  }

  const semanticId = `${repoIdentity}:check_run:${payload.check_run.id}:completed`;
  const headRef = payload.check_run.check_suite?.head_branch ?? null;
  const headSha = payload.check_run.head_sha ?? payload.check_run.check_suite?.head_sha ?? null;
  const providerEventAt = normalizeGitHubTimestamp(
    payload.check_run.completed_at ?? payload.check_run.started_at
  );

  return {
    event_type: "check_run",
    action,
    idempotency_key: buildDeliveryScopedKey(semanticId, deliveryId),
    semantic_id: semanticId,
    github_object_id: String(payload.check_run.id),
    github_object_url: payload.check_run.html_url,
    title: payload.check_run.name,
    state: payload.check_run.conclusion ?? payload.check_run.status,
    actor_login: actorLogin,
    provider_event_at: providerEventAt,
    provider_object_updated_at: providerEventAt,
    ref: headRef,
    base_ref: null,
    head_ref: headRef,
    head_sha: headSha,
    metadata: {
      status: payload.check_run.status,
      conclusion: payload.check_run.conclusion,
      app_name: payload.check_run.app?.name ?? null,
      suite_id: payload.check_run.check_suite?.id ?? null,
      head_branch: headRef,
      head_sha: headSha,
    },
    roomEvent: {
      ...base,
      kind: "check_run",
      checkRun: {
        id: String(payload.check_run.id),
        suiteId:
          payload.check_run.check_suite?.id !== undefined &&
          payload.check_run.check_suite?.id !== null
            ? Number(payload.check_run.check_suite.id)
            : null,
        name: payload.check_run.name,
        status: payload.check_run.status,
        conclusion: payload.check_run.conclusion,
        url: payload.check_run.html_url,
        appName: payload.check_run.app?.name ?? null,
      },
    },
  };
}

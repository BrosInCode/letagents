import type { GitHubWebhookPayload } from "../app.js";
import { buildDeliveryScopedKey, normalizeGitHubTimestamp } from "./helpers.js";
import type { MaterializedGitHubRoomEvent } from "./types.js";

/** Metadata for Activity only. None of these events can trigger task/chat effects. */
export function materializeActivityEvent(
  eventName: "workflow_run" | "workflow_job" | "pull_request_review_comment" | "pull_request_review_thread",
  payload: GitHubWebhookPayload, action: string, deliveryId: string, repo: string,
): MaterializedGitHubRoomEvent | null {
  const run = payload.workflow_run;
  const job = payload.workflow_job;
  const pr = payload.pull_request;
  const comment = payload.comment;
  const thread = payload.thread;
  const threadId = thread?.node_id ?? thread?.id;
  const workflow = eventName === "workflow_run" || eventName === "workflow_job";
  if (workflow && (!run || !["requested", "queued", "waiting", "in_progress", "completed"].includes(action))) return null;
  if (eventName === "workflow_job" && !job) return null;
  if (eventName === "pull_request_review_comment" && (!pr || !comment || !["created", "edited", "deleted"].includes(action))) return null;
  if (eventName === "pull_request_review_thread" && (!pr || !thread || !threadId || !["resolved", "unresolved"].includes(action))) return null;
  const runPr = run?.pull_requests?.length === 1 ? run.pull_requests[0] : null;
  const prNumber = workflow ? runPr?.number : pr?.number;
  const prUrl = prNumber ? `https://github.com/${repo}/pull/${prNumber}` : null;
  const object = eventName === "workflow_job" ? job : run;
  const attempt = eventName === "workflow_job" ? job?.run_attempt : run?.run_attempt;
  const at = normalizeGitHubTimestamp(workflow
    ? eventName === "workflow_job" ? job?.completed_at ?? job?.started_at ?? job?.created_at : run?.updated_at ?? run?.created_at
    : eventName === "pull_request_review_comment" ? comment?.updated_at ?? comment?.created_at : payload.updated_at ?? thread?.updated_at);
  const objectId = workflow ? String(object!.id) : String(prNumber);
  const identity = workflow ? `${objectId}:${attempt ?? "unknown"}` : String(comment?.id ?? threadId);
  // Thread state can cycle. Without a provider timestamp retain each delivery;
  // exact-delivery retries still dedupe and the presenter folds by thread ID.
  const semantic = `${repo}:${eventName}:${identity}:${action}:${at ?? (eventName === "pull_request_review_thread" ? deliveryId : "")}`;
  const sha = workflow ? run!.head_sha : pr?.head?.sha ?? null;
  const headRef = workflow
    ? run?.head_repository?.id === payload.repository?.id ? run?.head_branch ?? null : null
    : pr?.head?.ref ?? null;
  const metadata: Record<string, unknown> = {
    repository: repo, pull_request_number: prNumber ?? null, pull_request_url: prUrl,
    head_sha: sha, head_ref: headRef,
  };
  if (workflow) Object.assign(metadata, {
    workflow_id: run!.workflow_id ? String(run!.workflow_id) : null,
    run_id: String(run!.id), run_attempt: attempt ?? null,
    workflow_name: run!.name ?? "Workflow", run_title: run!.display_title ?? run!.name ?? "Workflow",
    run_url: run!.html_url, job_id: job && eventName === "workflow_job" ? String(job.id) : null,
    status: object!.status, conclusion: object!.conclusion,
    started_at: eventName === "workflow_job" ? job?.started_at : run?.run_started_at,
    completed_at: eventName === "workflow_job" ? job?.completed_at : action === "completed" ? run?.updated_at : null,
    pull_request_head_sha: runPr?.head?.sha ?? null,
  });
  else if (eventName === "pull_request_review_comment") Object.assign(metadata, {
    review_id: comment?.pull_request_review_id ? String(comment.pull_request_review_id) : null,
    comment_id: String(comment!.id), in_reply_to_id: comment?.in_reply_to_id ? String(comment.in_reply_to_id) : null,
    review_commit_id: comment?.commit_id ?? null,
  });
  else Object.assign(metadata, {
    thread_id: String(threadId), resolved: action === "resolved",
    // No bodies, diffs or paths are included, even for private rooms.
    comments: (thread?.comments ?? []).slice(0, 100).map(c => ({
      id: String(c.id), review_id: c.pull_request_review_id ? String(c.pull_request_review_id) : null,
      in_reply_to_id: c.in_reply_to_id ? String(c.in_reply_to_id) : null,
      actor_login: c.user?.login ?? null,
    })),
  });
  return {
    event_type: eventName, action, semantic_id: semantic,
    idempotency_key: buildDeliveryScopedKey(semantic, deliveryId),
    github_object_id: objectId,
    github_object_url: workflow ? object!.html_url : comment?.html_url ?? prUrl,
    title: workflow ? eventName === "workflow_job" ? job!.name : run!.display_title ?? run!.name ?? "Workflow" : pr!.title,
    state: workflow ? object!.conclusion ?? object!.status : action,
    actor_login: workflow ? payload.sender?.login ?? null : comment?.user?.login ?? payload.sender?.login ?? null,
    provider_event_at: at, provider_object_updated_at: at,
    ref: headRef, base_ref: pr?.base?.ref ?? null, head_ref: headRef, head_sha: sha, metadata,
    ...(prUrl && prNumber ? { routingEvent: {
      provider: "github" as const, kind: "pull_request" as const, action,
      repositoryFullName: repo, senderLogin: payload.sender?.login ?? null,
      // Use the exact PR URL for task ownership, not an ambiguous fork branch.
      pullRequest: { number: prNumber, url: prUrl, title: "", headRef: null, headSha: sha },
    } } : {}),
    roomEvent: null,
  };
}

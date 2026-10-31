import type { GitHubWebhookPayload, GitHubWorkflowRun } from "./app.js";
import { getGitHubAppConfig } from "./config.js";
import { githubRequestJson, mintInstallationToken } from "./app-client.js";

/** A job webhook has no PR association. Resolve its run before room routing,
 * including when jobs arrive before the workflow_run webhook. Never guess from
 * branch names or expose a job in the parent room pending a later correction. */
export async function enrichWorkflowJob(
  payload: GitHubWebhookPayload,
  readRun: (repository: string, runId: number, installationId: string) => Promise<GitHubWorkflowRun> = readWorkflowRun,
): Promise<GitHubWebhookPayload> {
  const job = payload.workflow_job;
  if (!job || !["queued", "in_progress", "completed", "waiting"].includes(payload.action ?? "")) return payload;
  const repository = payload.repository;
  const installationId = payload.installation?.id;
  if (!repository || !installationId || !Number.isSafeInteger(job.run_id) || job.run_id <= 0) {
    throw new Error("Workflow job requires repository, installation and run identity");
  }
  const run = await readRun(repository.full_name, job.run_id, String(installationId));
  if (run.id !== job.run_id || run.repository?.id !== repository.id || run.head_sha !== job.head_sha) {
    throw new Error("Workflow job/run identity mismatch");
  }
  return { ...payload, workflow_run: run };
}

async function readWorkflowRun(repository: string, runId: number, installationId: string): Promise<GitHubWorkflowRun> {
  const token = await mintInstallationToken({ config: await getGitHubAppConfig(), installationId });
  const repoPath = repository.split("/").map(encodeURIComponent).join("/");
  return await githubRequestJson({
    url: `https://api.github.com/repos/${repoPath}/actions/runs/${runId}`,
    token, timeoutMs: 10_000,
  }) as GitHubWorkflowRun;
}

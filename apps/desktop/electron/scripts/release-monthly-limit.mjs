import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_LIMIT = 10;
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

function startedAt(run) {
  const timestamp = Date.parse(run.run_started_at);
  if (!Number.isFinite(timestamp) || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
    throw new Error("GitHub returned invalid release attempt history; refusing to build.");
  }
  return timestamp;
}

export async function checkDesktopReleaseLimit({ repository, token, runId, runAttempt, fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || !token
    || !/^[1-9]\d*$/.test(String(runId ?? "")) || !/^[1-9]\d*$/.test(String(runAttempt ?? ""))) {
    throw new Error("Release limit requires GITHUB_REPOSITORY, GH_TOKEN, GITHUB_RUN_ID, and GITHUB_RUN_ATTEMPT.");
  }

  const api = `https://api.github.com/repos/${repository}/actions`;
  async function get(path) {
    const response = await fetchImpl(`${api}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Cannot read release attempt history (HTTP ${response.status}); refusing to build.`);
    return response.json();
  }

  // Anchor every check to this attempt, including matrix jobs crossing midnight.
  const current = await get(`/runs/${runId}/attempts/${runAttempt}`);
  const cutoff = startedAt(current);
  if (String(current.id) !== String(runId) || String(current.run_attempt) !== String(runAttempt)
    || !Number.isSafeInteger(current.workflow_id)) {
    throw new Error("GitHub returned a different release attempt; refusing to build.");
  }
  const localStart = new Date(cutoff + LAGOS_OFFSET_MS);
  const month = localStart.toISOString().slice(0, 7);
  const year = localStart.getUTCFullYear();
  const monthIndex = localStart.getUTCMonth();
  const monthStart = Date.UTC(year, monthIndex, 1) - LAGOS_OFFSET_MS;
  const resetMonth = new Date(Date.UTC(year, monthIndex + 1, 1)).toISOString().slice(0, 7);
  const attempts = new Set([`${runId}:${runAttempt}`]);

  // Do not filter by creation date: an older workflow can be retried this month.
  for (let page = 1; ; page += 1) {
    const response = await get(`/workflows/${current.workflow_id}/runs?per_page=100&page=${page}`);
    if (!Array.isArray(response.workflow_runs)) {
      throw new Error("GitHub returned invalid workflow history; refusing to build.");
    }
    for (const run of response.workflow_runs) {
      startedAt(run);
      if (!Number.isSafeInteger(run.id)) throw new Error("GitHub returned an invalid workflow run ID; refusing to build.");
      let attempt = run;
      for (let number = run.run_attempt; number >= 1; number -= 1) {
        const start = startedAt(attempt);
        if (attempt.id !== run.id || attempt.run_attempt !== number) {
          throw new Error("GitHub returned a different historical attempt; refusing to build.");
        }
        if (start < monthStart) break;
        // Newer queued runs cannot take away this attempt's place in the quota.
        const earlierAtSameSecond = run.id < Number(runId)
          || (run.id === Number(runId) && number <= Number(runAttempt));
        if (start < cutoff || (start === cutoff && earlierAtSameSecond)) attempts.add(`${run.id}:${number}`);
        if (number > 1) attempt = await get(`/runs/${run.id}/attempts/${number - 1}`);
      }
    }
    if (response.workflow_runs.length < 100) break;
  }

  return {
    allowed: attempts.size <= RELEASE_LIMIT,
    used: attempts.size,
    limit: RELEASE_LIMIT,
    month,
    resetsAt: `${resetMonth}-01 00:00 Africa/Lagos`,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = await checkDesktopReleaseLimit({
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GH_TOKEN,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    });
    const summary = `Desktop release attempt ${result.used}/${result.limit} for ${result.month} (Africa/Lagos). `
      + `Failures, cancellations, and retries count. Resets ${result.resetsAt}.`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    if (!result.allowed) throw new Error("Monthly desktop release attempt limit reached; try again next month.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

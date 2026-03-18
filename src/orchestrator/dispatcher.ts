import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import type { Plan, Task, TaskResult, WorkerConfig } from "./types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_URL = process.env.LETAGENTS_API_URL || "http://localhost:3001";
const POLL_TIMEOUT_MS = 60000; // 1 minute poll timeout
const DEFAULT_BASE_BRANCH = "dev";

const TASK_RESULT_SCHEMA = {
  type: "object",
  properties: {
    task_id: { type: "string" },
    status: { type: "string", enum: ["done", "failed"] },
    branch: { type: "string" },
    commit: { type: "string" },
    error: { type: "string" },
  },
  required: ["task_id", "status"],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiCall(path: string, options?: RequestInit) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }

  return res.json();
}

async function postAuditLog(projectId: string, text: string): Promise<void> {
  await apiCall(`/projects/${encodeURIComponent(projectId)}/messages`, {
    method: "POST",
    body: JSON.stringify({
      sender: "orchestrator",
      text,
    }),
  });
}

function sanitizeBranchName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function getWorktreePath(task: Task): string {
  return path.resolve(process.cwd(), "..", `letagents-${sanitizeBranchName(task.branch)}`);
}

async function ensureWorktree(task: Task): Promise<string> {
  const worktreePath = getWorktreePath(task);

  if (fs.existsSync(path.join(worktreePath, ".git"))) {
    return worktreePath;
  }

  const branchExists = await gitRefExists(`refs/heads/${task.branch}`);
  const args = branchExists
    ? ["worktree", "add", worktreePath, task.branch]
    : ["worktree", "add", worktreePath, "-b", task.branch, DEFAULT_BASE_BRANCH];

  await execFileAsync("git", args, { cwd: process.cwd() });
  return worktreePath;
}

async function gitRefExists(ref: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", ref], { cwd: process.cwd() });
    return true;
  } catch {
    return false;
  }
}

async function getBranchCommit(branch: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", branch], {
      cwd: process.cwd(),
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function getWorkerConfig(plan: Plan, assignee: string): WorkerConfig {
  return plan.workers?.[assignee] ?? {};
}

function buildTaskPrompt(task: Task): string {
  return [
    `You are assigned task ${task.id}: ${task.name}.`,
    `Description: ${task.description}`,
    `Use branch: ${task.branch}`,
    `When finished, respond with strict JSON matching this shape:`,
    `{"task_id":"${task.id}","status":"done|failed","branch":"${task.branch}","commit":"<commit hash>","error":"<optional error>"}`,
    `If the task fails, set status to "failed" and include error.`,
  ].join("\n");
}

function parseTaskResult(raw: string, taskId: string): TaskResult {
  const result = JSON.parse(raw) as TaskResult;

  if (result.task_id !== taskId) {
    throw new Error(`Task result mismatch: expected ${taskId}, got ${result.task_id}`);
  }

  if (result.status !== "done" && result.status !== "failed") {
    throw new Error(`Invalid task result status for ${taskId}`);
  }

  return result;
}

async function runCodex(task: Task, worktreePath: string, worker: WorkerConfig): Promise<TaskResult> {
  const schemaPath = path.join(os.tmpdir(), `${task.id}-task-result.schema.json`);
  const resultPath = path.join(os.tmpdir(), `${task.id}-codex-result.json`);
  fs.writeFileSync(schemaPath, JSON.stringify(TASK_RESULT_SCHEMA, null, 2));

  const args = [
    "exec",
    "--cd",
    worktreePath,
    "--output-schema",
    schemaPath,
    "-o",
    resultPath,
    ...(worker.args ?? []),
    buildTaskPrompt(task),
  ];

  await execFileAsync(worker.command ?? "codex", args, { cwd: worktreePath, maxBuffer: 1024 * 1024 * 10 });
  const raw = fs.readFileSync(resultPath, "utf8").trim();
  return parseTaskResult(raw, task.id);
}

async function runClaude(task: Task, worktreePath: string, worker: WorkerConfig): Promise<TaskResult> {
  const resultPath = path.join(os.tmpdir(), `${task.id}-claude-result.json`);
  const args = [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(TASK_RESULT_SCHEMA),
    "--dangerously-skip-permissions",
    ...(worker.args ?? []),
    buildTaskPrompt(task),
  ];

  const { stdout } = await execFileAsync(worker.command ?? "claude", args, {
    cwd: worktreePath,
    maxBuffer: 1024 * 1024 * 10,
  });
  fs.writeFileSync(resultPath, stdout);
  return parseTaskResult(stdout.trim(), task.id);
}

async function verifyTaskResult(task: Task, beforeCommit: string | null, result: TaskResult): Promise<TaskResult> {
  const branchCommit = await getBranchCommit(task.branch);

  if (result.status === "failed") {
    return {
      ...result,
      branch: result.branch ?? task.branch,
    };
  }

  if (!branchCommit) {
    throw new Error(`Task ${task.id} did not produce a branch commit on ${task.branch}`);
  }

  if (beforeCommit === branchCommit) {
    throw new Error(`Task ${task.id} did not create a new commit on ${task.branch}`);
  }

  if (result.commit && result.commit !== branchCommit) {
    throw new Error(`Task ${task.id} reported commit ${result.commit} but branch head is ${branchCommit}`);
  }

  return {
    ...result,
    branch: task.branch,
    commit: branchCommit,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a task to a worker. Uses direct CLI invocation when configured, otherwise falls back
 * to chat-based assignment and completion signaling.
 */
export async function dispatchTask(projectId: string, plan: Plan, task: Task): Promise<TaskResult | null> {
  const worker = getWorkerConfig(plan, task.assignee);

  if (worker.mode !== "chat" && (worker.mode === "cli" || task.assignee === "codex" || task.assignee === "claude")) {
    const worktreePath = await ensureWorktree(task);
    const beforeCommit = await getBranchCommit(task.branch);

    await postAuditLog(
      projectId,
      `📤 Dispatching ${task.id} (${task.name}) to ${task.assignee} via CLI in \`${worktreePath}\``
    );

    try {
      const rawResult = task.assignee === "claude"
        ? await runClaude(task, worktreePath, worker)
        : await runCodex(task, worktreePath, worker);
      const verifiedResult = await verifyTaskResult(task, beforeCommit, rawResult);

      await postAuditLog(
        projectId,
        `✅ ${task.id} ${verifiedResult.status} on \`${verifiedResult.branch}\`${verifiedResult.commit ? ` at \`${verifiedResult.commit}\`` : ""}`
      );
      console.log(`📤 Dispatched task ${task.id} (${task.name}) to ${task.assignee} via CLI`);
      return verifiedResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedResult: TaskResult = {
        task_id: task.id,
        status: "failed",
        branch: task.branch,
        error: message,
      };
      await postAuditLog(projectId, `❌ ${task.id} failed during ${task.assignee} CLI execution: ${message}`);
      return failedResult;
    }
  }

  const assignmentMessage = [
    `📋 **Task Assignment: ${task.id}**`,
    `**Name**: ${task.name}`,
    `**Assignee**: ${task.assignee}`,
    `**Branch**: \`${task.branch}\``,
    `**Description**: ${task.description}`,
    ``,
    `When complete, send a message with this exact JSON:`,
    `\`\`\`json`,
    `{"task_id": "${task.id}", "status": "done", "branch": "${task.branch}", "commit": "<commit_hash>"}`,
    `\`\`\``,
  ].join("\n");

  await postAuditLog(projectId, assignmentMessage);

  console.log(`📤 Dispatched task ${task.id} (${task.name}) to ${task.assignee} via chat fallback`);
  return null;
}

/**
 * Wait for a completion signal from an agent via Let Agents Chat.
 * Polls using the long-poll endpoint until a message containing a TaskResult JSON is found.
 */
export async function waitForCompletion(
  projectId: string,
  taskId: string,
  afterMessageId?: string
): Promise<{ result: TaskResult; lastMessageId: string }> {
  let after = afterMessageId;

  while (true) {
    const params = new URLSearchParams();
    if (after) params.set("after", after);
    params.set("timeout", String(POLL_TIMEOUT_MS));

    const queryString = params.toString();
    const response = await apiCall(
      `/projects/${encodeURIComponent(projectId)}/messages/poll?${queryString}`
    );

    const messages = response.messages as Array<{
      id: string;
      sender: string;
      text: string;
      timestamp: string;
    }>;

    if (messages.length > 0) {
      after = messages[messages.length - 1].id;

      // Look for a completion message with TaskResult JSON
      for (const msg of messages) {
        const result = tryParseTaskResult(msg.text, taskId);
        if (result) {
          return { result, lastMessageId: after };
        }
      }
    }

    // No completion signal yet — keep polling
  }
}

/**
 * Try to extract a TaskResult JSON from a message body.
 */
function tryParseTaskResult(text: string, taskId: string): TaskResult | null {
  // Look for JSON in code blocks or raw JSON
  const jsonPatterns = [
    /```json\s*\n?([\s\S]*?)\n?\s*```/,
    /```\s*\n?([\s\S]*?)\n?\s*```/,
    /(\{[\s\S]*?"task_id"[\s\S]*?\})/,
  ];

  for (const pattern of jsonPatterns) {
    const match = text.match(pattern);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]) as TaskResult;
        if (parsed.task_id === taskId && (parsed.status === "done" || parsed.status === "failed")) {
          return parsed;
        }
      } catch {
        // Not valid JSON, continue
      }
    }
  }

  return null;
}

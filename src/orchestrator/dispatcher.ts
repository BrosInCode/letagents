import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { Plan, Task, TaskResult, WorkerConfig } from "./types.js";
import { ensureWorktree, removeWorktreeIfClean } from "./worktrees.js";

function spawnAgent(command: string, args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(`  [${command}] ${text}`);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`  [${command}] ${chunk.toString()}`);
    });

    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code: code ?? 1 }));
  });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_URL = (process.env.LETAGENTS_API_URL || "http://localhost:3001").replace(/\/+$/, "");
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
  required: ["task_id", "status", "branch", "commit", "error"],
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

async function getBranchCommit(branch: string): Promise<string | null> {
  try {
    const { stdout, code } = await spawnAgent("git", ["rev-parse", "--verify", branch], process.cwd());
    if (code !== 0) return null;
    return stdout.trim();
  } catch {
    return null;
  }
}

async function cleanupTaskWorktree(task: Task, worktreePath: string): Promise<void> {
  try {
    const outcome = await removeWorktreeIfClean({ repoRoot: process.cwd(), worktreePath });
    if (outcome === "removed") {
      console.log(`🧹 Removed worktree for ${task.id} at ${worktreePath}`);
    } else if (outcome === "dirty") {
      console.log(`🧹 Kept worktree for ${task.id} at ${worktreePath} (uncommitted changes present)`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`🧹 Could not remove worktree for ${task.id} at ${worktreePath}: ${message}`);
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
    "--dangerously-bypass-approvals-and-sandbox",
    "--cd",
    worktreePath,
    "--output-schema",
    schemaPath,
    "-o",
    resultPath,
    ...(worker.args ?? []),
    buildTaskPrompt(task),
  ];

  const cmd = worker.command ?? "codex";
  const { code } = await spawnAgent(cmd, args, worktreePath);
  if (code !== 0) throw new Error(`${cmd} exited with code ${code}`);
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
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
    "--verbose",
    ...(worker.args ?? []),
    buildTaskPrompt(task),
  ];

  const cmd = worker.command ?? "claude";
  const { stdout, code } = await spawnAgent(cmd, args, worktreePath);
  if (code !== 0) throw new Error(`${cmd} exited with code ${code}`);
  fs.writeFileSync(resultPath, stdout);

  // Claude --output-format json emits a JSON array of event objects.
  // The structured output is in the {"type":"result","structured_output":{...}} event.
  try {
    const events = JSON.parse(stdout.trim());
    const arr = Array.isArray(events) ? events : [events];
    for (let i = arr.length - 1; i >= 0; i--) {
      const event = arr[i];
      if (event.type === "result" && event.structured_output) {
        const result = event.structured_output as TaskResult;
        if (result.task_id === task.id) return result;
      }
    }
  } catch {
    // Fallback: try newline-delimited JSON
    const lines = stdout.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]);
        if (event.type === "result" && event.structured_output) {
          const result = event.structured_output as TaskResult;
          if (result.task_id === task.id) return result;
        }
      } catch { /* skip */ }
    }
  }

  throw new Error(`Could not find structured_output in Claude result for ${task.id}`);
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

  if (result.commit && !branchCommit.startsWith(result.commit) && !result.commit.startsWith(branchCommit)) {
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
    const worktree = await ensureWorktree({
      repoRoot: process.cwd(),
      branch: task.branch,
      baseBranch: DEFAULT_BASE_BRANCH,
    });
    const worktreePath = worktree.worktreePath;
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

      // The task's commit lives on its branch, so the transient worktree can be
      // reclaimed once the task finishes cleanly. Only worktrees this dispatch
      // created are reclaimed — a reused pre-existing checkout (e.g. a
      // developer's own) is never removed. Uncommitted work is also preserved:
      // removeWorktreeIfClean skips removal when the working tree is dirty.
      if (verifiedResult.status === "done" && worktree.created) {
        await cleanupTaskWorktree(task, worktreePath);
      }
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

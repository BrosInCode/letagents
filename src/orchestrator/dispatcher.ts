import type { Task, TaskResult } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_URL = process.env.LETAGENTS_API_URL || "http://localhost:3001";
const POLL_TIMEOUT_MS = 60000; // 1 minute poll timeout

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

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a task to an agent by posting an assignment message to Let Agents Chat.
 */
export async function dispatchTask(projectId: string, task: Task): Promise<void> {
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

  await apiCall(`/projects/${encodeURIComponent(projectId)}/messages`, {
    method: "POST",
    body: JSON.stringify({
      sender: "orchestrator",
      text: assignmentMessage,
    }),
  });

  console.log(`📤 Dispatched task ${task.id} (${task.name}) to ${task.assignee}`);
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

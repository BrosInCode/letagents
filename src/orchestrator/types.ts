export type TaskStatus = "pending" | "ready" | "running" | "done" | "failed";
export type Assignee = "codex" | "claude";

export interface WorkerConfig {
  mode?: "cli" | "chat";
  command?: string;
  args?: string[];
}

export interface Task {
  id: string;
  name: string;
  description: string;
  assignee: Assignee | string;
  branch: string;
  depends_on: string[];
  status: TaskStatus;
}

export interface Plan {
  name: string;
  project_id: string;
  workers?: Record<string, WorkerConfig>;
  tasks: Task[];
}

export interface TaskResult {
  task_id: string;
  status: "done" | "failed";
  branch?: string;
  commit?: string;
  error?: string;
}

export type TaskStatus = "pending" | "ready" | "running" | "done" | "failed";
export type Assignee = "antigravity" | "codex";

export interface Task {
  id: string;
  name: string;
  description: string;
  assignee: Assignee;
  branch: string;
  depends_on: string[];
  status: TaskStatus;
}

export interface Plan {
  name: string;
  project_id: string;
  tasks: Task[];
}

export interface TaskResult {
  task_id: string;
  status: "done" | "failed";
  branch?: string;
  commit?: string;
  error?: string;
}

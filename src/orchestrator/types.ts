export interface Task {
  id: string;
  name: string;
  description: string;
  assignee: string;
  branch: string;
  depends_on: string[];
  status: "pending" | "ready" | "running" | "done" | "failed";
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

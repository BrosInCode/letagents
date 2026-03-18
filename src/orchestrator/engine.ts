import fs from "fs";
import YAML from "yaml";
import { type Plan, type Task, type TaskResult } from "./types.js";

function getTask(plan: Plan, taskId: string): Task {
  const task = plan.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new Error(`Unknown task dependency: ${taskId}`);
  }

  return task;
}

function normalizeTask(rawTask: Partial<Task> & Pick<Task, "id" | "name" | "description" | "assignee" | "branch">): Task {
  return {
    id: rawTask.id,
    name: rawTask.name,
    description: rawTask.description,
    assignee: rawTask.assignee,
    branch: rawTask.branch,
    depends_on: rawTask.depends_on ?? [],
    status: rawTask.status ?? "pending",
  };
}

function validatePlan(plan: Plan): Plan {
  const seenTaskIds = new Set<string>();

  for (const task of plan.tasks) {
    if (seenTaskIds.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }

    seenTaskIds.add(task.id);
  }

  for (const task of plan.tasks) {
    for (const dependencyId of task.depends_on) {
      getTask(plan, dependencyId);
      if (dependencyId === task.id) {
        throw new Error(`Task cannot depend on itself: ${task.id}`);
      }
    }
  }

  return plan;
}

export function loadPlan(yamlPath: string): Plan {
  const raw = fs.readFileSync(yamlPath, "utf8");
  const parsed = YAML.parse(raw) as Partial<Plan> | null;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Plan file did not contain a valid object");
  }

  if (typeof parsed.name !== "string" || typeof parsed.project_id !== "string" || !Array.isArray(parsed.tasks)) {
    throw new Error("Plan must include name, project_id, and tasks");
  }

  const plan: Plan = {
    name: parsed.name,
    project_id: parsed.project_id,
    tasks: parsed.tasks.map((task) => normalizeTask(task as Task)),
  };

  return validatePlan(plan);
}

export function updateTaskStatuses(plan: Plan): void {
  for (const task of plan.tasks) {
    if (task.status !== "pending" && task.status !== "ready") {
      continue;
    }

    const dependenciesDone = task.depends_on.every((dependencyId) => {
      const dependency = getTask(plan, dependencyId);
      return dependency.status === "done";
    });

    task.status = dependenciesDone ? "ready" : "pending";
  }
}

export function getReadyTasks(plan: Plan): Task[] {
  return plan.tasks.filter((task) => task.status === "ready");
}

export function markTaskRunning(plan: Plan, taskId: string): void {
  const task = getTask(plan, taskId);
  task.status = "running";
}

export function markTaskDone(plan: Plan, taskId: string, result: TaskResult): void {
  if (result.task_id !== taskId) {
    throw new Error(`Task result mismatch: expected ${taskId}, got ${result.task_id}`);
  }

  const task = getTask(plan, taskId);
  task.status = result.status;
}

export function isComplete(plan: Plan): boolean {
  return plan.tasks.some((task) => task.status === "failed")
    || plan.tasks.every((task) => task.status === "done");
}

export async function runLoop(
  plan: Plan,
  dispatch: (task: Task) => Promise<void>,
  onComplete: (taskId: string) => Promise<TaskResult>
): Promise<void> {
  updateTaskStatuses(plan);

  while (!isComplete(plan)) {
    const readyTasks = getReadyTasks(plan);

    if (readyTasks.length === 0) {
      throw new Error("No ready tasks available and plan is not complete");
    }

    for (const task of readyTasks) {
      markTaskRunning(plan, task.id);
      await dispatch(task);

      const result = await onComplete(task.id);
      markTaskDone(plan, task.id, result);
      updateTaskStatuses(plan);

      if (isComplete(plan)) {
        break;
      }
    }
  }
}

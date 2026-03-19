import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import type { Plan, Task, TaskResult } from "./types.js";
import { dispatchTask, waitForCompletion } from "./dispatcher.js";

// ---------------------------------------------------------------------------
// DAG Helpers
// ---------------------------------------------------------------------------

function loadPlan(yamlPath: string): Plan {
  const raw = readFileSync(yamlPath, "utf-8");
  const parsed = parseYaml(raw) as Plan;

  // Initialize all tasks to "pending"
  for (const task of parsed.tasks) {
    task.status = "pending";
    task.depends_on = task.depends_on || [];
  }

  return parsed;
}

function updateTaskStatuses(plan: Plan): void {
  for (const task of plan.tasks) {
    if (task.status !== "pending") continue;

    const allDepsDone = task.depends_on.every((depId) => {
      const dep = plan.tasks.find((t) => t.id === depId);
      return dep?.status === "done";
    });

    if (allDepsDone) {
      task.status = "ready";
    }
  }
}

function getReadyTasks(plan: Plan): Task[] {
  return plan.tasks.filter((t) => t.status === "ready");
}

function isComplete(plan: Plan): boolean {
  return plan.tasks.every((t) => t.status === "done" || t.status === "failed");
}

function hasFailed(plan: Plan): boolean {
  return plan.tasks.some((t) => t.status === "failed");
}

// ---------------------------------------------------------------------------
// Main Loop
// ---------------------------------------------------------------------------

async function run(yamlPath: string): Promise<void> {
  console.log(`\n🚀 Let Agents Chat Orchestrator`);
  console.log(`📄 Loading plan: ${yamlPath}\n`);

  const plan = loadPlan(yamlPath);
  console.log(`📋 Plan: ${plan.name}`);
  console.log(`📡 Project: ${plan.project_id}`);
  console.log(`📝 Tasks: ${plan.tasks.length}\n`);

  for (const task of plan.tasks) {
    console.log(`   ${task.id}: ${task.name} (${task.assignee}) [deps: ${task.depends_on.join(", ") || "none"}]`);
  }
  console.log("");

  let lastMessageId: string | undefined;

  while (!isComplete(plan)) {
    // Update statuses based on dependency resolution
    updateTaskStatuses(plan);

    if (hasFailed(plan)) {
      console.error("\n❌ A task failed. Stopping orchestrator.");
      break;
    }

    const readyTasks = getReadyTasks(plan);

    if (readyTasks.length === 0) {
      // Nothing ready — wait for running tasks to complete
      const runningTasks = plan.tasks.filter((t) => t.status === "running");
      if (runningTasks.length === 0) {
        console.error("\n⚠️ Deadlock: no ready or running tasks. Check dependencies.");
        break;
      }

      // Wait for completion of any running task
      for (const task of runningTasks) {
        console.log(`⏳ Waiting for ${task.id} (${task.name})...`);
        const { result, lastMessageId: newLastId } = await waitForCompletion(
          plan.project_id,
          task.id,
          lastMessageId
        );
        lastMessageId = newLastId;

        task.status = result.status;
        console.log(`${result.status === "done" ? "✅" : "❌"} ${task.id}: ${result.status}`);
        if (result.commit) console.log(`   commit: ${result.commit}`);
        break; // Re-evaluate after each completion
      }

      continue;
    }

    // Dispatch all ready tasks in parallel
    const dispatches = readyTasks.map(async (task) => {
      task.status = "running";
      console.log(`🚀 Dispatching ${task.id} (${task.name}) to ${task.assignee}...`);
      const directResult = await dispatchTask(plan.project_id, plan, task);
      if (directResult) {
        task.status = directResult.status;
        console.log(`${directResult.status === "done" ? "✅" : "❌"} ${task.id}: ${directResult.status}`);
        if (directResult.commit) console.log(`   commit: ${directResult.commit}`);
      }
    });

    await Promise.all(dispatches);
  }

  // Summary
  console.log("\n📊 Final Status:");
  for (const task of plan.tasks) {
    const icon = task.status === "done" ? "✅" : task.status === "failed" ? "❌" : "⏸️";
    console.log(`   ${icon} ${task.id}: ${task.name} — ${task.status}`);
  }

  const allDone = plan.tasks.every((t) => t.status === "done");
  console.log(allDone ? "\n🎉 All tasks complete!" : "\n⚠️ Some tasks did not complete.");
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

const yamlPath = process.argv[2];

if (!yamlPath) {
  console.error("Usage: npx tsx src/orchestrator/cli.ts <plan.yaml>");
  process.exit(1);
}

run(yamlPath).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

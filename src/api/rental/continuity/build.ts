import {
  CONTINUITY_COMMAND_CAP,
  CONTINUITY_FILE_CAP,
} from "./constants.js";
import { collectActiveDiff } from "./active-diff.js";
import { collectCommands } from "./commands.js";
import { collectFailingTests } from "./failing-tests.js";
import { collectFilesTouched } from "./files.js";
import { computePackId } from "./hash.js";
import type {
  BuildContinuityPackOptions,
  ContinuityPack,
  ContinuityPackEvent,
  ContinuityPackSession,
} from "./types.js";

/**
 * Build the deterministic half of the Continuity Pack from a session row
 * and activity events. The events may be passed in any order.
 */
export function buildContinuityPack(
  session: ContinuityPackSession,
  events: ReadonlyArray<ContinuityPackEvent>,
  options: BuildContinuityPackOptions = {},
): ContinuityPack {
  const generatedAt = options.nowIso ?? new Date().toISOString();

  const files = collectFilesTouched(events);
  const commands = collectCommands(events);
  const failingTests = collectFailingTests(events);
  const activeDiff = collectActiveDiff(events);

  const fileTotal = files.length;
  const commandTotal = commands.length;

  const pack: ContinuityPack = {
    packId: "",
    schemaVersion: 1,
    tier: "tier1_deterministic",
    generatedAt,
    session: {
      id: session.id,
      taskTitle: session.task_title,
      taskPrompt: session.task_prompt,
      baseBranch: session.base_branch,
      workBranch: session.work_branch,
      status: session.status,
      mode: session.mode,
    },
    approvedScope: session.approved_scope ?? null,
    policy: session.policy ?? null,
    filesTouched: files.slice(0, CONTINUITY_FILE_CAP),
    filesTouchedSummary: {
      totalCount: fileTotal,
      truncatedCount: Math.max(0, fileTotal - CONTINUITY_FILE_CAP),
    },
    commandsRun: commands.slice(0, CONTINUITY_COMMAND_CAP),
    commandsRunSummary: {
      totalCount: commandTotal,
      truncatedCount: Math.max(0, commandTotal - CONTINUITY_COMMAND_CAP),
    },
    failingTests,
    activeDiff,
  };

  pack.packId = computePackId(pack);
  return pack;
}

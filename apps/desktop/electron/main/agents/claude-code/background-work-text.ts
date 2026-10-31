

/**
 * A room turn stays open for background work that it started, so the room gets one complete answer.
 *
 * The model can start a shell command or a sub-agent that goes on after the tool call that started it. Claude
 * Code ends the command with the model's interim answer. It tells the model later how the work ended: with the
 * next request of whatever turn is running, or else in a turn of its own, whose result names no command.
 * 1. The turn's own result arrives, and work that the turn started has not been reported to the model: the
 *    turn does not end. Its answer is kept, and its result line is kept back.
 * 2. Each later result that answers the notice of such work adds its text.
 * 3. Work that still runs keeps the turn open up to the limit of its kind. Work that has ended keeps it open
 *    until the model has answered its notice. The turn ends when no work keeps it open. The reply is the
 *    kept texts in their order, with a blank line between them. Empty texts and repeated texts are left out.
 * 4. The turn also ends with what it has when an answer to a notice fails, and when all the work that it
 *    waits for has ended and no answer begins in time. Its owner can end the wait at any time: the reply is
 *    then posted with what the turn has. A reply that lacks something says so in one plain line.
 * 5. One answer can be about several notices: the CLI gives the model every notice that waits with one
 *    request. The answer is the turn's when any of those notices is of the turn's work, and the turn does
 *    not end while such an answer runs.
 * 6. A turn that ends while an answer to a notice still runs, or is due, leaves the CLI free: the adapter
 *    denies what that answer asked the owner to approve, and interrupts it. The next prompt would wait
 *    behind that answer, and behind an approval that nobody can give any more it would wait for ever.
 * An answer to a notice that comes after the turn has ended is not posted, and it ends no other turn.
 */
/** A sub-agent is finite work, and its report is the answer. No turn stays open longer than this. */
export const CLAUDE_BACKGROUND_SUBAGENT_WAIT_LIMIT_MS = 30 * 60_000;
/**
 * A command that runs in the background is often a server or a watcher that is meant to go on. Any other kind
 * of background task has not been captured, and gets this limit too.
 */
export const CLAUDE_BACKGROUND_COMMAND_WAIT_LIMIT_MS = 2 * 60_000;
/**
 * The notice of work that has ended is answered at once: the CLI has nothing else to do. The stream shows no
 * line for the start of that answer, and a notice that the running turn took with its last request gets no
 * answer of its own at all. So a turn whose work has all ended waits this long for a first line, and no longer.
 */
export const CLAUDE_BACKGROUND_NOTICE_START_LIMIT_MS = 5 * 60_000;
/** The turn is held open: the owner reads what it waits for, and for how long. The one event of these that Chat shows. */
export const CLAUDE_BACKGROUND_WORK_METHOD = "letagents/backgroundWork";
/** The result that answers a task's notice. It ends no turn, and its failure is not the agent's. */
export const CLAUDE_BACKGROUND_WORK_ANSWER_METHOD = "letagents/backgroundWorkAnswer";
/** The same result when no room turn runs: the agent is idle after it. */
export const CLAUDE_BACKGROUND_WORK_FINISHED_METHOD = "letagents/backgroundWorkFinished";
/**
 * The daemon's room-level state carries the newest sixteen activity events of an agent, and Chat reads the wait
 * from them. So a turn that is held open says again what it waits for after this many other lines.
 */
export const CLAUDE_BACKGROUND_WORK_NOTICE_EVERY_LINES = 8;
const wholeMinutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
export const CLAUDE_BACKGROUND_WORK_TEXT = {
  // Added to the room reply, as one line after the model's texts. Each is true for every case that posts it.
  /** A command passed its limit: a server or a watcher that goes on, or a long command. That is no fault. */
  commandStillRuns: "A command that this turn started was still running in the background when this reply was posted. Claude's later answer about it will not be posted.",
  /** Work of a kind that is not known passed its limit. */
  stillRunning: "Background work that this turn started was still running when this reply was posted. Claude's later answer about it will not be posted.",
  /** A sub-agent passed its limit, and was stopped with the turn. Its report was the answer, so this is a fault. */
  subagentTimedOut: "A sub-agent that this turn started did not finish in the time allowed, and was stopped. Its report is not in this reply and will not be posted.",
  /** A sub-agent still ran when the turn ended for another reason, and was stopped with the turn. */
  subagentStopped: "A sub-agent that this turn started still ran when the turn ended, and was stopped. Its report is not in this reply and will not be posted.",
  /** The work had ended, and the answer to its notice failed or was not there in time. */
  notReported: "Background work that this turn started has ended, but Claude's report on it is not in this reply.",
  /** The owner ended the wait: with Stop, or with "Post answer now". Only the owner's request to stop the turn posts it. */
  ownerEnded: "The owner ended the wait for background work that this turn started. A later result will not be posted.",
  /**
   * The live result was missed, and the reply was read from the session. The rows that were read for the turn
   * hold no notice of some of its work: the work still ran when the session ended, or it was stopped, or
   * another prompt came before its notice. True for each of these.
   */
  noReportInSession: "This reply was read from Claude's saved session. A report on background work that this turn started is missing from it.",
  // For the owner, in the agent's activity.
  limitReached: "The wait for background work reached its time limit. The turn was ended, and a later result will not be posted to the room.",
  noAnswerBegan: "Background work has ended and Claude gave no further answer about it. The turn was ended with the answer it had.",
  answerFailed: "Claude could not answer about background work that ended:",
  /** An answer that no open turn waits for: its turn has ended, or the work never had one. */
  notPosted: "Claude answered about background work that no open room turn waits for. The answer was not posted to the room.",
  /** The same, for an answer that was interrupted or that failed. */
  notPostedUnfinished: "An answer about background work that no open room turn waits for was stopped or failed. Nothing was posted to the room.",
} as const;

/**
 * What the owner reads while a turn is held open: the work that still keeps it open, by kind, in the model's
 * own short descriptions. The times stand before the descriptions, because Chat cuts a long line at its end.
 * `endedMs` is how long ago the last of the work ended, for a turn that only waits for the answer about it.
 */
export function claudeBackgroundWorkWaitSummary(
  waitsFor: ReadonlyArray<{ description: string; kind: "subagent" | "command" | "other"; running: boolean }>,
  waitedMs: number,
  endedMs = 0,
  commandLimitMs = CLAUDE_BACKGROUND_COMMAND_WAIT_LIMIT_MS,
): string {
  const time = (ms: number) => ms < 60_000 ? "under 1 min" : `${Math.floor(ms / 60_000)} min`;
  const named = (subagent: boolean) => {
    const all = waitsFor.filter((task) => task.running && (task.kind === "subagent") === subagent).map((task) => `"${task.description}"`);
    return { count: all.length, list: `${all.slice(0, 3).join(", ")}${all.length > 3 ? ` and ${all.length - 3} more` : ""}` };
  };
  const subagents = named(true);
  const others = named(false);
  // Only a shell command is called a command. Work of another kind is waited for as long, and has no name here.
  const whatElse = waitsFor.some((task) => task.running && task.kind === "other") ? "background work"
    : others.count === 1 ? "a background command" : "background commands";
  const forOthers = `up to ${wholeMinutes(commandLimitMs)} min for ${whatElse}: ${others.list}.`;
  if (subagents.count) {
    return `Waiting for ${subagents.count === 1 ? "a sub-agent" : "sub-agents"} to finish (${time(waitedMs)}): ${subagents.list}.${others.count ? ` Also ${forOthers}` : ""}`;
  }
  return others.count ? `Waiting ${forOthers}` : `Waiting for Claude's answer about background work that ended ${time(endedMs)} ago.`;
}

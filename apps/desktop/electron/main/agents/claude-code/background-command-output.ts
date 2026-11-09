import { basename, dirname, isAbsolute } from "node:path";
import {
  BackgroundCommandOutput as AgentBackgroundCommandOutput,
  backgroundEndStatus,
  type BackgroundCommandOutputInput as AgentBackgroundCommandOutputInput,
  type BackgroundOutputFormat,
} from "../background-command-output.js";

/** Claude Code ends the file of a command with this line. */
const EXIT_LINE = /\n?\[exited with code (-?\d+)\]\s*$/;

/** Claude Code's output file: the command's output, then the exit line when it ends. */
export const CLAUDE_BACKGROUND_OUTPUT: BackgroundOutputFormat = {
  body: (raw, final) => final ? raw.replace(EXIT_LINE, "") : raw,
  exitCode: (raw) => {
    const match = EXIT_LINE.exec(raw);
    return match ? Number(match[1]) : null;
  },
};

/**
 * The file in which Claude Code writes the output of a command that it runs
 * in the background, read from the result of the tool call that started it:
 * "Command running in background with ID: <id>. Output is being written to:
 * <path>". The task id comes from the result's structured fields, never from
 * its text: a command's own output can print any text. The file must be
 * `<session>/tasks/<task id>.output`, in the CLI's own folder for the session.
 */
export function claudeBackgroundOutputPath(resultText: string, taskId: string, sessionId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId) || !sessionId) return null;
  // The path ends with the task's file name; it can hold spaces (a Windows user folder).
  const match = new RegExp(`Output is being written to: (.+?[\\\\/]${taskId}\\.output)(?=[\\s.,;]|$)`).exec(resultText);
  if (!match) return null;
  const path = match[1]!;
  if (!isAbsolute(path) || basename(path) !== `${taskId}.output`) return null;
  const tasks = dirname(path);
  if (basename(tasks) !== "tasks" || basename(dirname(tasks)) !== sessionId) return null;
  return path;
}

/** How a background task ended, from Claude Code's status and the command's exit code. */
export const claudeBackgroundEndStatus = backgroundEndStatus;

export type BackgroundCommandOutputInput = Omit<AgentBackgroundCommandOutputInput, "format">;

/** Follows the output file of one command that Claude Code runs in the background (see the shared follower). */
export class BackgroundCommandOutput extends AgentBackgroundCommandOutput {
  constructor(input: BackgroundCommandOutputInput) {
    super({ ...input, format: CLAUDE_BACKGROUND_OUTPUT });
  }
}

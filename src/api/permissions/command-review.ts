/**
 * Automatic review of an agent's shell commands, on the server.
 *
 * The desktop applies the fixed rules before it calls here, and this module
 * applies them again: the server never forwards a command to Jev that the
 * rules reserve for a person. The answer is advice to the desktop that asked.
 * It is "allow" or "ask", never a denial, and every failure is "ask".
 */
import {
  PERMISSION_REVIEW_MAX_COMMANDS,
  buildPermissionReviewRequest,
  decidePermissionReview,
  parsePermissionReviewAnswers,
  type PermissionReviewAnswers,
} from "../../../shared/permission-review.mjs";
import { requestJevEvaluation, type JevEndpoint } from "../messages/jev-conversation-routing.js";

export type CommandReviewInput = { commands: string[]; project: string };

export type CommandReviewReason =
  /** Jev answered and the answer decided. */
  | "reviewed"
  /** A fixed rule reserves the command for a person. */
  | "needs_person"
  /** The server holds no Jev credential, or Jev did not answer in time. */
  | "unavailable";

export type CommandReviewResult = {
  decision: "allow" | "ask";
  reason: CommandReviewReason;
  answers: PermissionReviewAnswers | null;
};

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** The exact request shape, or null. Unknown fields are refused, not ignored. */
export function parseCommandReviewInput(value: unknown): CommandReviewInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || !Array.isArray(input.commands)
    || input.commands.length === 0 || input.commands.length > PERMISSION_REVIEW_MAX_COMMANDS
    || !input.commands.every((command) => boundedText(command, 2_000))
    || !boundedText(input.project, 1_024)) return null;
  return { commands: [...input.commands] as string[], project: input.project };
}

export async function reviewCommands(
  input: CommandReviewInput,
  deps: {
    endpoint: JevEndpoint | null;
    evaluate?: typeof requestJevEvaluation;
  },
): Promise<CommandReviewResult> {
  const request = buildPermissionReviewRequest({ commands: input.commands, project: input.project });
  if (!request) return { decision: "ask", reason: "needs_person", answers: null };
  if (!deps.endpoint) return { decision: "ask", reason: "unavailable", answers: null };
  try {
    const { body } = await (deps.evaluate ?? requestJevEvaluation)(deps.endpoint, {
      state: request.state,
      questions: request.questions,
    });
    const answers = parsePermissionReviewAnswers(body);
    return { decision: decidePermissionReview(answers), reason: "reviewed", answers };
  } catch {
    // Provider errors may echo the commands. Report only that no answer came.
    return { decision: "ask", reason: "unavailable", answers: null };
  }
}

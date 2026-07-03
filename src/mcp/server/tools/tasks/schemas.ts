import { z } from "zod";

export const TASK_STATUSES = [
  "proposed",
  "accepted",
  "assigned",
  "in_progress",
  "blocked",
  "in_review",
  "merged",
  "done",
  "cancelled",
] as const;

export const workerTaskIdentitySchema = {
  room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
  conversation_id: z
    .string()
    .optional()
    .describe("Deprecated for worker writes; registered worker session identity is used."),
  agent_session_id: z
    .string()
    .optional()
    .describe("Registered agent session to use for this task action. Required for worker task writes."),
};

export const boardIntentApprovalSchema = {
  board_intent_id: z.string().optional().describe("Approved board intent id for high-impact board actions."),
  board_approval_token: z.string().optional().describe("Scoped approval token returned by approve_board_intent."),
};

export const taskReviewIdentitySchema = {
  ...workerTaskIdentitySchema,
  agent_session_id: z
    .string()
    .optional()
    .describe("Registered agent session to use for this review action. Required for worker review writes."),
};

export const taskLeaseIdentitySchema = {
  ...workerTaskIdentitySchema,
  agent_session_id: z
    .string()
    .optional()
    .describe("Registered agent session to use for this lease action. Required for worker lease writes."),
};

export const deprecatedAssigneeSchema = z
  .string()
  .optional()
  .describe("Deprecated override. Agent identity is resolved automatically on room entry.");

export const workflowArtifactSchema = z
  .object({
    provider: z.enum(["github", "gitlab", "bitbucket", "unknown"]),
    kind: z.enum(["issue", "branch", "pull_request", "merge_request", "review", "check_run", "merge"]),
    id: z.string().nullable().optional(),
    number: z.number().int().nullable().optional(),
    title: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    ref: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
  })
  .strict();

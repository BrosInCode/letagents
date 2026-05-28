/**
 * Provider-neutral repository workflow facade.
 *
 * The public import path remains stable while provider parsing, task
 * workflow artifact handling, event formatting, and board projection
 * live under ./repo-workflow by responsibility.
 */

export type * from "./repo-workflow/types.js";
export type {
  BoardProjectionResult,
  TaskStatusLike,
} from "./repo-workflow/board-projection.js";

export {
  buildRepoRoomId,
  extractReferencedTaskId,
  parseRepoRoomName,
} from "./repo-workflow/repo-room.js";
export {
  buildLegacyTaskWorkflowArtifacts,
  buildTaskWorkflowArtifactMatches,
  buildTaskWorkflowRefs,
  normalizeTaskWorkflowArtifacts,
  synchronizeTaskWorkflowArtifactsWithPrUrl,
  validateTaskWorkflowArtifactsInput,
} from "./repo-workflow/task-artifacts.js";
export {
  buildRepoRoomEventArtifactMatches,
  formatRepoCheckRunEventMessage,
  formatRepoIssueCommentEventMessage,
  formatRepoIssueEventMessage,
  formatRepoPullRequestEventMessage,
  formatRepoPullRequestReviewEventMessage,
  formatRepoRepositoryEventMessage,
  formatRepoRoomEventMessage,
  getRepoRoomEventReferenceTexts,
} from "./repo-workflow/events.js";
export {
  projectIssueEvent,
  projectPullRequestEvent,
  projectPullRequestReviewEvent,
  projectRepoRoomEvent,
  shouldAutoPromptForBoardProjection,
} from "./repo-workflow/board-projection.js";

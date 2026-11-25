// The public surface of the Claude Code provider adapter. Internal layers of
// the adapter class and helpers that only the adapter reads stay unexported.
export { ClaudeCodeProviderAdapter } from "./adapter.js";
export type { ClaudeCliChild, ClaudeCodeProviderAdapterDependencies, ClaudeCodeProviderAdapterOptions } from "./types.js";
export {
  claudeCliLaunchArgs,
  claudeLaunchPolicyArgs,
  claudeOwnerSetupReadsProjectInstructionsOnly,
  claudeOwnerSetupStartEnvironment,
  ownerMcpServerNotices,
  ownerMcpStartupTimeoutMs,
} from "./launch-args.js";
export { boundedClaudeRoomTurnPrompt, guestHasOnlyRoomTools } from "./stream-messages.js";
export {
  CLAUDE_BACKGROUND_COMMAND_WAIT_LIMIT_MS,
  CLAUDE_BACKGROUND_NOTICE_START_LIMIT_MS,
  CLAUDE_BACKGROUND_SUBAGENT_WAIT_LIMIT_MS,
  CLAUDE_BACKGROUND_WORK_ANSWER_METHOD,
  CLAUDE_BACKGROUND_WORK_FINISHED_METHOD,
  CLAUDE_BACKGROUND_WORK_METHOD,
  CLAUDE_BACKGROUND_WORK_TEXT,
  claudeBackgroundWorkWaitSummary,
} from "./background-work-text.js";
export { claudeStartWithoutModelText } from "./bootstrap-diagnostics.js";
export {
  claudeChildEnvironment,
  claudeCliEnv,
  claudeSessionTranscriptCandidates,
  claudeTranscriptsRoot,
  createEphemeralClaudeMcpConfig,
  createManagedClaudeMcpConfig,
} from "./child-process.js";

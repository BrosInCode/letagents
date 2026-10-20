// Compatibility entry point. The Cursor managed profile lives in ./cursor/;
// this file keeps every existing import path and exported name working.
export {
  assertWorkspaceDoesNotConfigureAnyCursorMcp,
  assertWorkspaceDoesNotConfigureLetAgentsMcp,
  bindCursorSupervisedIdentity,
  cursorSupervisedMcpServerName,
  DEFAULT_CURSOR_MCP_POLICY,
  filterLetAgentsCursorMcpConfig,
  normalizeCursorMcpPolicy,
  prepareCursorManagedProfile,
  prepareCursorSupervisedProfile,
  relocateCursorConversationNamespace,
  removeCursorSupervisedProfile,
  type CursorManagedProfile,
  type CursorManagedProfileOptions,
  type CursorPersonalIdentity,
  type CursorSupervisedProfileOptions,
} from "./cursor/managed-profile.js";

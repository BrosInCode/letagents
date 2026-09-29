export type GitHubRoomChatEventKind =
  | "pull_request"
  | "review"
  | "comment"
  | "issue"
  | "check_failed"
  | "repository";

export declare const GITHUB_ROOM_CHAT_EVENT_KINDS: readonly GitHubRoomChatEventKind[];
export declare const ROOM_AGENT_GUIDELINES_TOKEN_BUDGET: number;
export declare const ROOM_AGENT_GUIDELINES_BYTES_PER_TOKEN: number;
export declare const ROOM_AGENT_GUIDELINES_MAX_BYTES: number;
export declare const ROOM_AGENT_GUIDELINES_NOTE: string;

export interface GitHubRoomChatEventFilter {
  room_id: string;
  /** The kinds posted to the room as messages, in canonical order. */
  enabled_kinds: GitHubRoomChatEventKind[];
  all_kinds: GitHubRoomChatEventKind[];
  /** The room these kinds were read from when this room has none of its own. */
  inherited_from_room_id: string | null;
  can_manage: boolean;
}

export interface RoomAgentGuidelines {
  room_id: string;
  guidelines: string | null;
  updated_by: string | null;
  updated_at: string | null;
  /** The room these guidelines were read from when this room has none of its own. */
  inherited_from_room_id: string | null;
  max_bytes: number;
  token_budget: number;
  note: string;
  can_manage: boolean;
}

/** The text as stored: `\n` line endings, no control characters, trimmed. Not a string gives "". */
export declare function normalizeRoomAgentGuidelines(value: unknown): string;
/** Whether the text has the marks of a binary file rather than of writing. */
export declare function looksLikeBinaryText(value: unknown): boolean;
/** The size the limit is enforced on: UTF-8 bytes of the normalized text. */
export declare function roomAgentGuidelinesBytes(value: unknown): number;
export declare function estimateRoomAgentGuidelineTokens(value: unknown): number;
/** The enabled kinds in canonical order, or null when the input is invalid. */
export declare function normalizeGitHubRoomChatEventKinds(value: unknown): GitHubRoomChatEventKind[] | null;
/** The kind a repository event is filed under, or null when it has none. */
export declare function githubRoomChatEventKind(event: { kind?: string } | null | undefined): GitHubRoomChatEventKind | null;

/** One file changed by one successful edit call. `path` is as the provider gave it (absolute, or relative to the workspace). */
export type AgentEditEvidence = { path: string; additions: number; deletions: number; patch: string; patch_truncated: boolean };
/** Cut a patch at a line boundary so that it holds at most `maxChars` characters. */
export function boundEditPatch(patch: string, maxChars?: number): { patch: string; truncated: boolean };
/** One raw Claude Code stream-json message: a `user` message with an Edit/Write/MultiEdit `tool_use_result`. */
export function claudeEditEvidence(message: unknown): AgentEditEvidence[] | null;
/** One Codex app-server notification: `item/completed` of a completed `fileChange` item. */
export function codexEditEvidence(method: string, params: unknown): AgentEditEvidence[] | null;
/** The evidence of one raw event from a provider that reports edits (codex, claude-code), or null. */
export function providerEditEvidence(provider: string, method: string, payload: unknown): AgentEditEvidence[] | null;

export type IdeKey = 'codex' | 'antigravity' | 'claude' | 'cursor' | 'opencode' | 'default'

// Labels arrive in several spellings ("Claude", "Claude Code", "claude-code";
// "OpenCode", "Open Model"), so match on a compact form, not the exact text.
export function ideKey(label: string): IdeKey {
  const compact = label.toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (compact === 'codex') return 'codex'
  if (compact === 'antigravity') return 'antigravity'
  if (compact === 'claude' || compact === 'claudecode') return 'claude'
  if (compact === 'cursor') return 'cursor'
  if (compact === 'opencode' || compact === 'openmodel') return 'opencode'
  return 'default'
}

/** Presentation-only shape shared by the desktop and web history adapters. */
export interface AgentChange {
  id: string;
  title: string;
  kind: string;
  byline: string;
  state: string;
  failed: boolean;
  time: string | null;
  url: string | null;
  linkLabel: string;
  branch: string | null;
  tasks: string[];
}

export function agentChange(input: {
  id: string; kind: string; provider: string; title?: string | null;
  number?: number | null; state?: string | null; time?: string | null;
  url?: string | null; branch?: string | null; tasks: string[];
}): AgentChange {
  const kind = ({ pull_request: 'Pull request', merge_request: 'Merge request', check_run: 'Check', change_summary: 'Changes' } as Record<string, string>)[input.kind]
    || sentenceCase(input.kind);
  const provider = ({ github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', git: 'Git' } as Record<string, string>)[input.provider] || '';
  const label = `${kind}${input.number != null ? ` #${input.number}` : ''}`;
  const state = ({ success: 'Passed', failure: 'Failed', timed_out: 'Timed out' } as Record<string, string>)[input.state || ''] || sentenceCase(input.state || '');
  return {
    id: input.id, kind: input.kind,
    // An internal artifact identity is never a user-facing fallback title.
    title: input.title?.trim() || input.branch?.trim() || label,
    byline: [label, provider].filter(Boolean).join(' · '),
    state, failed: ['failure', 'failed', 'error', 'timed_out'].includes(input.state || ''),
    time: input.time || null, url: input.url || null,
    linkLabel: `${label}${provider ? ` on ${provider}` : ''}`,
    branch: input.branch || null, tasks: input.tasks,
  };
}
function sentenceCase(value: string): string {
  const text = value.trim().replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function timestamp(value: string | null): number { return Date.parse(value || '') || 0; }
export function groupChanges(records: readonly AgentChange[], query: string, now = new Date()) {
  const groups = new Map<string, { day: string; records: AgentChange[] }>();
  const today = now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const search = query.trim().toLowerCase();
  for (const record of [...records].sort((a, b) => timestamp(b.time) - timestamp(a.time) || a.id.localeCompare(b.id))) {
    if (![record.title, record.byline, record.state, record.branch, ...record.tasks].join(' ').toLowerCase().includes(search)) continue;
    const date = new Date(record.time || '');
    const valid = Number.isFinite(date.getTime());
    const key = valid ? date.toDateString() : 'unknown';
    const day = !valid ? 'Date not recorded' : key === today ? 'Today' : key === yesterday.toDateString() ? 'Yesterday' : date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    if (!groups.has(key)) groups.set(key, { day, records: [] });
    groups.get(key)!.records.push(record);
  }
  return [...groups.values()];
}
export function changeTime(value: string | null): string {
  const date = new Date(value || '');
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'Not recorded';
}

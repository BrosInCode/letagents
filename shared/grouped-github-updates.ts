import { githubUrl, type ActivityGroup, type ActivityJob, type ActivityRun } from './ui/activity/model';

export interface GitHubUpdateEvent {
  kind: string; tone: string; kindLabel: string; statusLabel: string | null;
  headline: string; detail: string | null; repository: string | null; url: string | null;
}
export interface GitHubGroup<M> { type: 'github-group'; id: string; anchorId: string; messages: M[] }

/** Only neighboring updates share a block. Any conversation or date divider ends it. */
export function groupGitHubUpdates<E, M extends { id: string; timestamp: string }>(
  entries: readonly E[], messageFor: (entry: E) => M | null, eventFor: (message: M) => GitHubUpdateEvent | null, previous: readonly (E | GitHubGroup<M>)[] = [],
): Array<E | GitHubGroup<M>> {
  const result: Array<E | GitHubGroup<M>> = [];
  let current: GitHubGroup<M> | null = null;
  let day = '';
  const prior = new Map<string, GitHubGroup<M>>();
  for (const entry of previous) {
    if (entry && typeof entry === 'object' && 'type' in entry && entry.type === 'github-group' && 'messages' in entry) {
      const group = entry as GitHubGroup<M>;
      for (const message of group.messages) prior.set(message.id, group);
    }
  }
  for (const entry of entries) {
    const message = messageFor(entry);
    const event = message && eventFor(message);
    if (!message || !event) { current = null; result.push(entry); continue; }
    const messageDay = new Date(message.timestamp).toDateString();
    if (!current || messageDay !== day) {
      current = { type: 'github-group', id: `github:${message.id}`, anchorId: message.id, messages: [] };
      result.push(current);
    }
    day = messageDay;
    current.messages.push(message);
  }
  const claimed = new Set<string>();
  for (const entry of result) {
    if (!entry || typeof entry !== 'object' || !('type' in entry) || entry.type !== 'github-group' || !('messages' in entry)) continue;
    const group = entry as GitHubGroup<M>;
    const memberIds = new Set(group.messages.map(message => message.id));
    const existing = group.messages.map(message => prior.get(message.id)).find(candidate => candidate && memberIds.has(candidate.anchorId) && !claimed.has(candidate.id));
    if (existing) { group.id = existing.id; group.anchorId = existing.anchorId; claimed.add(existing.id); }
  }
  return result;
}

/** A URL's artifact identity, never a title, bare PR number, or nearby task. */
export function githubArtifactKey(event: GitHubUpdateEvent, messageId: string): string {
  try {
    const url = new URL(event.url || '');
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return `message:${messageId}`;
    const match = /^\/([^/]+)\/([^/]+)\/(pull|issues|actions\/runs)\/(\d+)(?:\/|$)/i.exec(url.pathname);
    if (!match) return `message:${messageId}`;
    const repository = `${match[1]}/${match[2]}`.toLowerCase();
    if (event.repository && repository !== event.repository.toLowerCase()) return `message:${messageId}`;
    const key = `${repository}/${match[3].toLowerCase()}/${match[4]}`;
    // Check-run notifications describe one job, not the whole workflow. Two
    // jobs sharing a run URL must not overwrite each other's outcome.
    return event.kind === 'check' ? `${key}/check/${encodeURIComponent(checkName(event))}` : key;
  } catch { return `message:${messageId}`; }
}

export function githubUpdateRows<M extends { id: string; timestamp: string }>(messages: readonly M[], eventFor: (message: M) => GitHubUpdateEvent | null) {
  const rows = new Map<string, { key: string; title: string; label: string; event: GitHubUpdateEvent; eventMessageId: string; messages: M[] }>();
  for (const message of messages) {
    const event = eventFor(message);
    if (!event) continue;
    const key = githubArtifactKey(event, message.id);
    const title = ['pull-request', 'issue'].includes(event.kind) ? event.detail : event.kind === 'check' ? `Check ${checkName(event)}` : null;
    const label = /\/(pull|issues)\/(\d+)$/.exec(key);
    const existing = rows.get(key);
    if (existing) {
      existing.messages.push(message);
      if (title) existing.title = title;
      // A later review/comment must not erase an already merged/closed artifact.
      if (!['merged', 'closed'].includes(existing.event.statusLabel?.toLowerCase() || '') || ['pull-request', 'issue'].includes(event.kind)) { existing.event = event; existing.eventMessageId = message.id; }
    } else rows.set(key, { key, title: title || (label ? `${label[1] === 'pull' ? 'Pull request' : 'Issue'} #${label[2]}` : event.headline),
      label: label ? `#${label[2]}` : event.kindLabel, event, eventMessageId: message.id, messages: [message] });
  }
  return [...rows.values()];
}

/** Keeps a mounted block stable when pagination discovers its earlier history. */
export function createGitHubTimeline<E, M extends { id: string; timestamp: string }>() {
  let previous: Array<E | GitHubGroup<M>> = [];
  let scope: string | null | undefined;
  return (entries: readonly E[], messageFor: (entry: E) => M | null, eventFor: (message: M) => GitHubUpdateEvent | null, nextScope?: string | null) => {
    if (scope !== nextScope) previous = [];
    scope = nextScope;
    previous = groupGitHubUpdates(entries, messageFor, eventFor, previous);
    return previous;
  };
}

function checkName(event: GitHubUpdateEvent): string {
  const suffix = ` ${event.statusLabel || ''}`;
  const headline = event.headline.toLowerCase().endsWith(suffix.toLowerCase()) ? event.headline.slice(0, -suffix.length) : event.headline;
  return headline.replace(/^Check /i, '');
}

export interface GitHubChatHighlight {
  key: string; title: string; label: string; status: string; merged: boolean;
  branch: string | null; url: string; time: string;
  sourceMessageId: string; activityEventId: string | null;
  checks: Pick<ActivityJob, 'name' | 'state' | 'url'>[];
}

/** A chat preview is bounded; the original rows and Activity history stay intact. */
export const githubChatHighlightLimit = 3;

function artifactUrl(value: string | null, repository?: string | null): string | null {
  const safe = githubUrl(value);
  const match = safe && /^(https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues|actions\/runs)\/\d+)(?:[/?#]|$)/i.exec(safe);
  return match && (!repository || match[2].toLowerCase() === repository.toLowerCase()) ? match[1].toLowerCase() : null;
}

export function failedGitHubCheck(state: string): boolean {
  return ['failed', 'failure', 'timed out', 'action required', 'startup failure'].includes(state.toLowerCase());
}

/** Use provider identities for PR context. Never infer a PR from a nearby message or task. */
export function githubChatHighlights<M extends { id: string; timestamp: string }>(
  rows: ReturnType<typeof githubUpdateRows<M>>, groups: readonly ActivityGroup[] = [],
): GitHubChatHighlight[] {
  const context = new Map<string, ActivityGroup | null>();
  const activityIds = new Map<string, string>();
  const exactActivityIds = new Map<string, string>();
  for (const group of groups) {
    for (const event of group.events) {
      const key = artifactUrl(event.github_object_url);
      if (key) activityIds.set(key, event.id);
      const exact = githubUrl(event.github_object_url)?.toLowerCase();
      if (exact) exactActivityIds.set(exact, event.id);
    }
    // Legacy check_run events have no PR relation; their job URLs must not
    // mask the explicit PR/run association supplied by workflow events.
    if (group.kind === 'event') continue;
    for (const url of [group.url, ...group.events.flatMap(event => [event.github_object_url, typeof event.metadata?.run_url === 'string' ? event.metadata.run_url : null])]) {
      const key = artifactUrl(url);
      if (!key) continue;
      const previous = context.get(key);
      if (!context.has(key) || previous?.id === group.id || previous?.kind === 'workflow' && group.kind === 'pr') context.set(key, group);
      else if (!(previous?.kind === 'pr' && group.kind === 'workflow')) context.set(key, null);
    }
  }
  const highlights = new Map<string, GitHubChatHighlight>();
  const fallbackRuns = new Set<string>();
  for (const row of rows) {
    const url = artifactUrl(row.event.url, row.event.repository);
    if (!url) continue;
    const merged = row.event.statusLabel?.toLowerCase() === 'merged';
    const source = merged ? row.messages.find(message => message.id === row.eventMessageId)! : row.messages.at(-1)!;
    const activityEventId = exactActivityIds.get(githubUrl(row.event.url)?.toLowerCase() || '') || activityIds.get(url) || null;
    const group = context.get(url);
    if (group) {
      // A later successful run, merge or new head must silence old failures.
      if (group.merged ? !merged : !group.attention) continue;
      const previous = highlights.get(group.id);
      if (previous && Date.parse(previous.time) > Date.parse(source.timestamp)) continue;
      const latestRuns = new Map<string, ActivityRun>();
      for (const run of group.runs) if (!group.head || run.sha === group.head) latestRuns.set(run.workflowId, run);
      const latest = group.events.at(-1);
      const branch = latest?.metadata?.head_ref || latest?.metadata?.head_branch;
      highlights.set(group.id, {
        key: group.id, title: group.title, label: group.number ? `#${group.number}` : 'Workflow',
        status: group.status, merged: group.merged, branch: typeof branch === 'string' ? branch : null,
        url: group.url || url, time: source.timestamp, sourceMessageId: source.id, activityEventId: group.events.at(-1)?.id || null,
        checks: [...latestRuns.values()].flatMap(run => run.jobs),
      });
      continue;
    }
    const time = source.timestamp;
    if (row.event.kind === 'check' && /\/actions\/runs\/\d+$/.test(url)) {
      let highlight = highlights.get(url);
      if (!highlight) {
        highlight = { key: url, title: `Workflow #${url.split('/').at(-1)}`, label: row.event.repository || 'GitHub',
          status: 'Checks need attention', merged: false, branch: null, url, time, sourceMessageId: source.id, activityEventId, checks: [] };
        highlights.set(url, highlight);
        fallbackRuns.add(url);
      }
      const status = row.event.statusLabel || 'Unknown';
      highlight.checks.push({ name: checkName(row.event), state: ({success:'Passed',failure:'Failed'} as Record<string,string>)[status.toLowerCase()] || status, url: githubUrl(row.event.url) });
      if (failedGitHubCheck(status) || !highlight.checks.some(check => failedGitHubCheck(check.state))) highlight.activityEventId = activityEventId;
      if (Date.parse(time) >= Date.parse(highlight.time)) { highlight.time = time; highlight.sourceMessageId = source.id; }
    } else if (row.event.statusLabel?.toLowerCase() === 'merged' || row.event.statusLabel?.toLowerCase() === 'changes requested') {
      highlights.set(row.key, { key: row.key, title: row.title, label: row.label, status: row.event.statusLabel,
        merged, branch: null, url, time, sourceMessageId: source.id, activityEventId, checks: [] });
    }
  }
  return [...highlights.values()]
    .filter(item => !fallbackRuns.has(item.key) || item.checks.some(check => failedGitHubCheck(check.state)))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
    .slice(-githubChatHighlightLimit);
}

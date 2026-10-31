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
  const rows = new Map<string, { key: string; title: string; label: string; event: GitHubUpdateEvent; messages: M[] }>();
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
      if (!['merged', 'closed'].includes(existing.event.statusLabel?.toLowerCase() || '') || ['pull-request', 'issue'].includes(event.kind)) existing.event = event;
    } else rows.set(key, { key, title: title || (label ? `${label[1] === 'pull' ? 'Pull request' : 'Issue'} #${label[2]}` : event.headline),
      label: label ? `#${label[2]}` : event.kindLabel, event, messages: [message] });
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

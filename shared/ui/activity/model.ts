/** The public room event shape, shared by desktop and web. Bodies are never used. */
export interface ActivityEvent {
  id: string; event_type: string; action: string; github_object_id: string | null;
  github_object_url: string | null; title: string | null; state: string | null;
  actor_login: string | null; created_at: string; metadata: Record<string, unknown> | null;
  linked_task_id: string | null; provider_event_at?: string | null;
  provider_object_updated_at?: string | null; event_order_at?: string | null; head_sha?: string | null;
}
export type ActivityFilter = 'all' | 'review' | 'attention' | 'merged';
export interface ActivityReview {
  id: string; actor: string; verdict: string; comments: number; resolved: number; unresolved: number;
  update: string; time: string; submittedAt: string; url: string | null; commit: string | null; dismissed: boolean;
}
export interface ActivityJob { id: string; name: string; state: string; time: string; duration: string; url: string | null }
export interface ActivityRun {
  id: string; runId: string; workflowId: string; attempt: number | null; name: string; state: string; sha: string | null;
  time: string; url: string | null; jobs: ActivityJob[];
}
export interface ActivityGroup {
  id: string; title: string; actor: string; number: string | null; url: string | null;
  kind: 'pr' | 'workflow' | 'event'; time: string; firstReceived: string; head: string | null;
  status: string; tone: string; inReview: boolean; attention: boolean; merged: boolean;
  summary: string; events: ActivityEvent[]; reviews: ActivityReview[]; runs: ActivityRun[]; taskIds: string[];
}
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
const meta = (event: ActivityEvent) => event.metadata || {};
export function eventTime(event: ActivityEvent): string {
  return [event.provider_object_updated_at, event.provider_event_at, event.event_order_at, event.created_at]
    .find(value => value && Number.isFinite(Date.parse(value))) || '';
}
const stamp = (value: string) => Date.parse(value) || 0;
function compare(left: ActivityEvent, right: ActivityEvent): number {
  return stamp(eventTime(left)) - stamp(eventTime(right)) || stamp(left.created_at) - stamp(right.created_at) || left.id.localeCompare(right.id);
}
export function githubUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function prUrl(event: ActivityEvent): string | null {
  const candidate = githubUrl(meta(event).pull_request_url) || githubUrl(event.github_object_url);
  const match = candidate?.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+)(?:[/?#]|$)/);
  return match?.[1] || null;
}
export function activityKey(event: ActivityEvent): string {
  const pr = prUrl(event);
  if (pr) return pr.toLowerCase();
  const repository = text(meta(event).repository) || '';
  if (event.event_type.startsWith('workflow_') && meta(event).run_id) return `${repository}:run:${meta(event).run_id}`;
  const url = githubUrl(event.github_object_url);
  return url?.replace(/#.*$/, '') || `${repository}:${event.event_type}:${event.github_object_id || event.id}`;
}
export function mergeActivityEvents<T extends { id: string }>(current: readonly T[], incoming: readonly T[]): T[] {
  return [...new Map([...current, ...incoming].map(event => [event.id, event])).values()];
}
function terminal(event: ActivityEvent): boolean { return event.action === 'completed' || meta(event).status === 'completed'; }
function latestState(events: ActivityEvent[]): ActivityEvent {
  // A late queued delivery cannot undo completion of this exact run attempt/job.
  const completed = events.filter(terminal);
  return [...(completed.length ? completed : events)].sort(compare).slice(-1)[0]!;
}
function state(event: ActivityEvent): string {
  const value = text(meta(event).conclusion) || text(meta(event).status) || event.state || event.action;
  return ({success:'Passed', failure:'Failed', timed_out:'Timed out', cancelled:'Cancelled', action_required:'Action required', in_progress:'Running', queued:'Queued', requested:'Queued', waiting:'Waiting', pending:'Pending', neutral:'Neutral', skipped:'Skipped', completed:'Completed'} as Record<string,string>)[value] || value.replace(/_/g, ' ');
}
const failed = (value: string) => ['Failed', 'Timed out', 'Action required'].includes(value);
function duration(event: ActivityEvent): string {
  const started = stamp(text(meta(event).started_at) || '');
  const ended = stamp(text(meta(event).completed_at) || '');
  if (!started || !ended || ended < started) return '—';
  const seconds = Math.floor((ended - started) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function runsFor(events: ActivityEvent[]): ActivityRun[] {
  const runs = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    const m = meta(event); if (!event.event_type.startsWith('workflow_') || !m.run_id) continue;
    const key = `${m.run_id}:${m.run_attempt || 'unknown'}`;
    runs.set(key, [...runs.get(key) || [], event]);
  }
  return [...runs].map(([id, updates]) => {
    const runUpdates = updates.filter(event => event.event_type === 'workflow_run');
    const latest = latestState(runUpdates.length ? runUpdates : updates);
    const m = meta(latest);
    const jobs = new Map<string, ActivityEvent[]>();
    for (const event of updates) {
      if (event.event_type !== 'workflow_job') continue;
      const jobId = text(meta(event).job_id) || event.github_object_id || event.id;
      jobs.set(jobId, [...jobs.get(jobId) || [], event]);
    }
    return {
      id, runId: String(m.run_id), workflowId: text(m.workflow_id) || String(m.run_id), attempt: Number(m.run_attempt) || null,
      name: text(m.workflow_name) || 'Workflow', state: runUpdates.length ? state(latest) : 'Awaiting run update',
      sha: text(m.pull_request_head_sha) || latest.head_sha || text(m.head_sha),
      time: eventTime(latest), url: githubUrl(m.run_url),
      jobs: [...jobs].map(([jobId, jobEvents]) => {
        const job = latestState(jobEvents);
        return { id: jobId, name: job.title || 'Job', state: state(job), time: eventTime(job), duration: duration(job), url: githubUrl(job.github_object_url) };
      }).sort((a,b) => a.id.localeCompare(b.id, undefined, { numeric: true })),
    };
  }).sort((a,b) => a.runId.localeCompare(b.runId, undefined, { numeric: true }) || (a.attempt || 0) - (b.attempt || 0));
}
function reviewsFor(events: ActivityEvent[]): ActivityReview[] {
  const reviews = new Map<string, { review: ActivityReview; comments: Map<string, boolean>; threads: Map<string, boolean> }>();
  function ensure(id: string, event: ActivityEvent, actor?: string | null) {
    let entry = reviews.get(id);
    if (!entry) {
      entry = { review: { id, actor: actor || event.actor_login || 'Reviewer', verdict: 'Commented', comments: 0, resolved: 0, unresolved: 0, update: 'Review activity', time: eventTime(event), submittedAt: '', url: githubUrl(event.github_object_url), commit: null, dismissed: false }, comments: new Map(), threads: new Map() };
      reviews.set(id, entry);
    }
    return entry;
  }
  for (const event of [...events].sort(compare)) {
    const m = meta(event);
    if (event.event_type === 'pull_request_review') {
      // Legacy review payloads encode the provider review ID in the fragment.
      const id = text(m.review_id) || event.github_object_url?.match(/#pullrequestreview-(\d+)/)?.[1] || event.id;
      const entry = ensure(id, event);
      const dismissed = event.action === 'dismissed' || entry.review.dismissed;
      Object.assign(entry.review, {
        actor: event.actor_login || entry.review.actor,
        verdict: dismissed ? 'Dismissed' : ({ approved:'Approved', changes_requested:'Changes requested', commented:'Commented', pending:'Pending' } as Record<string,string>)[event.state || ''] || 'Reviewed',
        dismissed, submittedAt: text(m.review_submitted_at) || eventTime(event), commit: text(m.review_commit_id), url: githubUrl(event.github_object_url), time: eventTime(event),
        update: dismissed ? 'Review dismissed' : 'Review submitted',
      });
    } else if (event.event_type === 'pull_request_review_comment') {
      const id = text(m.review_id) || `comment:${m.comment_id || event.id}`;
      const entry = ensure(id, event);
      const commentId = String(m.comment_id || event.id);
      // GitHub comment IDs cannot be undeleted. A late edit may carry the same
      // provider timestamp as deletion, so preserve its tombstone.
      if (entry.comments.get(commentId) === false && event.action !== 'deleted') continue;
      entry.comments.set(commentId, event.action !== 'deleted');
      entry.review.time = eventTime(event);
      entry.review.update = event.action === 'edited' ? 'Comment edited' : event.action === 'deleted' ? 'Comment removed' : 'New comment';
    } else if (event.event_type === 'pull_request_review_thread') {
      const comments = Array.isArray(m.comments) ? m.comments as Record<string, unknown>[] : [];
      const entries = new Set<string>();
      for (const comment of comments) {
        const id = text(comment.review_id) || `comment:${comment.id}`;
        const entry = ensure(id, event, text(comment.actor_login));
        // Thread snapshots establish identity, but cannot resurrect a deleted comment.
        if (!entry.comments.has(String(comment.id))) entry.comments.set(String(comment.id), true);
        entries.add(id);
      }
      for (const id of entries) {
        const entry = reviews.get(id)!;
        entry.threads.set(String(m.thread_id), m.resolved === true);
        entry.review.time = eventTime(event);
        entry.review.update = m.resolved === true ? 'Discussion resolved' : 'Discussion reopened';
      }
    }
  }
  return [...reviews.values()].map(entry => ({
    ...entry.review, comments: [...entry.comments.values()].filter(Boolean).length,
    resolved: [...entry.threads.values()].filter(Boolean).length,
    unresolved: [...entry.threads.values()].filter(value => !value).length,
  }));
}
export function groupActivity(events: readonly ActivityEvent[]): ActivityGroup[] {
  const grouped = new Map<string, ActivityEvent[]>();
  for (const event of events) { const key = activityKey(event); grouped.set(key, [...grouped.get(key) || [], event]); }
  return [...grouped].map(([id, unsorted]) => {
    const updates = [...unsorted].sort(compare);
    const latest = updates.slice(-1)[0]!;
    const pr = updates.filter(event => event.event_type === 'pull_request').slice(-1)[0];
    const url = prUrl(latest) || prUrl(updates[0]) || githubUrl(latest.github_object_url);
    const isPr = Boolean(prUrl(latest) || prUrl(updates[0]));
    const head = pr?.head_sha || text(pr && meta(pr).head_sha);
    const runs = runsFor(updates);
    const reviews = reviewsFor(updates);
    const merged = pr?.state === 'merged' || meta(pr || latest).merged === true;
    const open = isPr && !merged && pr?.state === 'open';
    const latestByReviewer = new Map<string, ActivityReview>();
    for (const review of reviews) {
      if (!['Approved', 'Changes requested', 'Dismissed'].includes(review.verdict)) continue;
      const before = latestByReviewer.get(review.actor);
      if (!before || stamp(review.submittedAt) >= stamp(before.submittedAt)) latestByReviewer.set(review.actor, review);
    }
    const changes = [...latestByReviewer.values()].some(review => review.verdict === 'Changes requested');
    const currentRuns = runs.filter(run => !head || run.sha === head);
    const latestAttempts = new Map<string, ActivityRun>();
    // Different workflow runs are retained; only the most recent run for a provider-identified
    // workflow on the current PR head contributes to its summary.
    for (const run of currentRuns) latestAttempts.set(run.workflowId, run);
    const activeRuns = [...latestAttempts.values()];
    const ciFailed = activeRuns.some(run => failed(run.state) || run.state === 'Awaiting run update' && run.jobs.some(job => failed(job.state)))
      || latest.event_type === 'check_run' && failed(state(latest));
    const running = activeRuns.some(run => ['Running','Queued','Waiting','Pending','Awaiting run update'].includes(run.state));
    const attention = !merged && pr?.state !== 'closed' && (changes || ciFailed);
    const status = merged ? 'Merged' : pr?.state === 'closed' ? 'Closed' : changes ? 'Changes requested' : ciFailed ? 'Build failed' : running ? 'CI running' : isPr ? !pr ? 'Review activity' : meta(pr).draft === true ? 'Draft' : 'In review' : runs.slice(-1)[0]?.state || (latest.event_type === 'check_run' ? state(latest) : latest.state?.replace(/_/g, ' ')) || latest.action.replace(/_/g, ' ');
    const reviewLatest = [...reviews].sort((a,b) => stamp(a.time) - stamp(b.time)).slice(-1)[0];
    const summary = reviewLatest && stamp(reviewLatest.time) >= stamp(eventTime(latest)) ? `${reviewLatest.actor} · ${reviewLatest.update.toLowerCase()}` : latest.event_type.startsWith('workflow_') ? `${latest.title || 'Workflow'} · ${state(latest).toLowerCase()}` : `${latest.actor_login || 'GitHub'} · ${latest.action.replace(/_/g, ' ')}`;
    return {
      id, title: pr?.title || (isPr ? updates.find(event => !event.event_type.startsWith('workflow_') && event.title)?.title : null) || text(meta(latest).run_title) || latest.title || 'Repository activity',
      actor: text(pr && meta(pr).author_login) || pr?.actor_login || latest.actor_login || 'GitHub', number: url?.match(/\/(?:pull|issues)\/(\d+)/)?.[1] || null,
      url, kind: isPr ? 'pr' as const : runs.length ? 'workflow' as const : 'event' as const,
      time: eventTime(latest), firstReceived: [...updates].sort((a,b) => stamp(a.created_at) - stamp(b.created_at))[0].created_at,
      head, status, tone: merged ? 'purple' : attention ? 'red' : running ? 'blue' : 'muted',
      inReview: open && meta(pr || latest).draft !== true, attention, merged, summary,
      events: updates, reviews, runs, taskIds: [...new Set(updates.map(event => event.linked_task_id).filter((value): value is string => Boolean(value)))],
    };
  }).sort((a,b) => stamp(b.time) - stamp(a.time) || a.id.localeCompare(b.id));
}
export function matchesActivity(group: ActivityGroup, filter: ActivityFilter, query: string): boolean {
  return (filter === 'all' || filter === 'review' && group.inReview || filter === 'attention' && group.attention || filter === 'merged' && group.merged)
    && `${group.title} ${group.actor} ${group.number || ''} ${group.reviews.map(review => review.actor).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase());
}
export function activityTime(value: string): string {
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

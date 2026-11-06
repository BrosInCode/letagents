import { boardTaskPlanning, type BoardPlanningSnapshot, type BoardSprint } from '../../board-planning.mjs';
import type { BoardTask } from './types';

export function sprintDates(sprint: BoardSprint): string {
  if (!sprint.startDate || !sprint.endDate) return 'Dates not set';
  const format = (value: string) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(value));
  return `${format(sprint.startDate)} – ${format(sprint.endDate)}`;
}

/** Compare calendar weekdays, never milliseconds (DST and timezone offsets change those). */
export function sprintClock(sprint: BoardSprint | undefined, today = new Date().toISOString().slice(0, 10)) {
  if (!sprint?.startDate || !sprint.endDate) return null;
  const start = Date.parse(sprint.startDate.slice(0, 10)), end = Date.parse(sprint.endDate.slice(0, 10));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const weekdays = (until: number) => {
    const days = Math.max(0, Math.floor((until - start) / 86400000) + 1);
    let count = Math.floor(days / 7) * 5;
    for (let offset = 0; offset < days % 7; offset += 1) {
      const day = (new Date(start).getUTCDay() + offset) % 7;
      if (day !== 0 && day !== 6) count += 1;
    }
    return count;
  };
  const total = weekdays(end), elapsed = weekdays(Math.min(end, Date.parse(today)));
  return total ? { total, elapsed, left: total - elapsed, fraction: elapsed / total } : null;
}

export function taskOwner(task: BoardTask, snapshot: BoardPlanningSnapshot) {
  const imported = snapshot.imported.tasks[task.id];
  if (imported && Object.prototype.hasOwnProperty.call(imported, 'assigneeId')) {
    return { key: imported.assigneeId || '', name: imported.assigneeName || 'Unassigned', provider: null, agent: false, avatarUrl: imported.assigneeAvatarUrl || null };
  }
  return { key: task.assigneeKey || task.assigneeLabel || '', name: task.assigneeLabel || 'Unassigned', provider: task.provider,
    agent: Boolean(task.assigneeKey || task.provider), avatarUrl: task.avatarUrl };
}

export function matchesSprint(task: BoardTask, snapshot: BoardPlanningSnapshot, id: string): boolean {
  const planning = boardTaskPlanning(snapshot, task.id);
  if (id === 'all') return true;
  if (Object.prototype.hasOwnProperty.call(snapshot.document.tasks[task.id] || {}, 'sprintId')) {
    return id === 'none' ? !planning.sprintId : planning.sprintId === id;
  }
  const memberships = snapshot.imported.tasks[task.id]?.sprintIds || (planning.sprintId ? [planning.sprintId] : []);
  return id === 'none' ? !memberships.length : memberships.includes(id);
}

export function taskStoryStatus(task: BoardTask, snapshot: BoardPlanningSnapshot): string {
  return statusLabel(snapshot.imported.tasks[task.id]?.ticketState || task.status);
}

export function taskIsBlocked(task: BoardTask, snapshot: BoardPlanningSnapshot): boolean {
  return taskStoryStatus(task, snapshot).toLowerCase() === 'blocked';
}

export function completedTask(task: BoardTask, snapshot: BoardPlanningSnapshot): boolean {
  const imported = snapshot.imported.tasks[task.id];
  return typeof imported?.done === 'boolean' ? imported.done : ['done', 'merged'].includes(task.status);
}

export function assigneeStories(all: readonly BoardTask[], visible: readonly BoardTask[], snapshot: BoardPlanningSnapshot, sprint?: BoardSprint, today?: string) {
  const target = sprint ? snapshot.document.sprintTargets[sprint.id] ?? snapshot.document.defaultTargetPoints : 0;
  const clock = sprintClock(sprint, today);
  const keys = [...new Set(visible.map(task => taskOwner(task, snapshot).key))];
  return keys.map(key => {
    const tasks = all.filter(task => taskOwner(task, snapshot).key === key && task.status !== 'cancelled');
    const items = visible.filter(task => taskOwner(task, snapshot).key === key);
    const owner = taskOwner(items[0], snapshot);
    const estimate = (task: BoardTask) => boardTaskPlanning(snapshot, task.id).estimate;
    const sum = (rows: readonly BoardTask[]) => rows.reduce((total, task) => total + (estimate(task) ?? 0), 0);
    const completed = sum(tasks.filter(task => completedTask(task, snapshot)));
    const planned = sum(tasks), review = sum(tasks.filter(task => /^(in review|code review|review)$/i.test(taskStoryStatus(task, snapshot)) && !completedTask(task, snapshot)));
    const blocked = sum(tasks.filter(task => taskIsBlocked(task, snapshot) && !completedTask(task, snapshot)));
    const unknown = tasks.filter(task => estimate(task) == null).length;
    const stale = sprint?.source?.stale;
    const active = sprint?.state === 'active' && !stale, future = sprint?.state === 'future' && !stale;
    const hasTarget = Boolean(key && (active || future));
    const value = future ? planned : completed;
    const expected = Math.round(target * (clock?.fraction || 0) * 10) / 10;
    let label = 'Current work', tone = 'muted', summary = `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`;
    if (!key) { label = 'Needs an owner'; summary += unknown ? ` · ${unknown} unestimated` : ''; }
    else if (stale) { label = 'Status unavailable'; summary = 'Waiting for the tracker to refresh this sprint'; }
    else if (sprint?.state === 'closed') { label = 'Sprint ended'; summary = 'Current task state; no sprint-end snapshot'; }
    else if (future) {
      label = unknown ? 'Estimates missing' : planned >= target ? 'Fully planned' : 'Planning';
      summary = unknown ? `${unknown} ${unknown === 1 ? 'task needs' : 'tasks need'} an estimate` : planned >= target ? 'Enough work planned for the target' : `${target - planned} SP still to plan`;
    } else if (active) {
      label = completed >= target ? 'Target met' : unknown ? 'Estimates missing' : !clock ? 'In progress' : completed < expected ? 'Behind pace' : completed / target >= .8 ? 'Close to target' : 'On pace';
      tone = label === 'Target met' ? 'green' : label === 'Behind pace' ? 'amber' : unknown ? 'muted' : 'blue';
      summary = completed >= target ? 'Sprint target completed' : `${target - completed} SP to go`;
      if (blocked) summary += ` · ${blocked} SP blocked`;
      else if (review) summary += ` · ${review} SP in review`;
      if (unknown) summary += ` · ${unknown} unestimated`;
    }
    return { key, owner, items, completed, planned, unknown, target, value, hasTarget, label, tone, summary,
      ratio: target ? Math.min(1, value / target) : 0, expected, pace: hasTarget && active && clock ? clock.fraction : null };
  }).sort((a, b) => !a.key ? 1 : !b.key ? -1 : a.owner.name.localeCompare(b.owner.name));
}

export function statusLabel(value: string): string {
  return ({ proposed: 'Proposed', accepted: 'Accepted', assigned: 'Assigned', in_progress: 'In progress', blocked: 'Blocked', in_review: 'In review', merged: 'Merged', done: 'Done', cancelled: 'Cancelled' } as Record<string, string>)[value] || value;
}

export function columnTone(statuses: readonly string[]): string {
  return statuses.includes('in_progress') ? 'blue' : statuses.includes('in_review') ? 'violet' : statuses.includes('done') || statuses.includes('merged') ? 'green' : 'muted';
}

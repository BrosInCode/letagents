import type { BoardPlanningSnapshot } from '../../board-planning.mjs';
export function releaseDescription(snapshot: BoardPlanningSnapshot): string {
  const rule = snapshot.document.releaseRule;
  if (!rule) return '';
  if (rule.kind === 'column') return `${snapshot.document.columns.find(c => c.id === rule.columnId)?.name || 'Release column'} · leaves the queue when moved out`;
  const source = snapshot.releases?.sources.find(s => s.id === rule.connectionId);
  const field = source?.fields.find(f => f.id === rule.fieldId);
  return `${source?.name || 'Tracker'} · ${field?.name || 'Release field'}: ${rule.value === 'true' ? 'Enabled' : rule.value === 'false' ? 'Disabled' : rule.value}`;
}

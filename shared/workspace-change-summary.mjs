// Bounded room-visible source changes. Absolute host paths and arbitrary metadata
// are excluded; patch text is intentional review content, never execution input.
export const WORKSPACE_PATCH_LIMIT = 128 * 1024;
export const WORKSPACE_FILE_LIMIT = 200;
const states = ['added', 'modified', 'deleted', 'renamed', 'copied', 'typechange', 'untracked', 'unknown'];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const count = value => Number.isSafeInteger(value) && value >= 0;
const path = value => typeof value === 'string' && value.length > 0 && value.length <= 2048
  && !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !value.split(/[\\/]/).includes('..')
  && !/[\x00-\x1f\x7f]/.test(value);

export function parseWorkspaceChangeSummary(value) {
  if (!exact(value, ['captured_at', 'branch', 'base_revision', 'state', 'files', 'additions', 'deletions', 'hidden_files', 'patch', 'patch_truncated'])
    || typeof value.captured_at !== 'string' || !Number.isFinite(Date.parse(value.captured_at))
    || !(value.branch === null || typeof value.branch === 'string' && value.branch.length <= 256 && !/[\x00-\x1f\x7f]/.test(value.branch))
    || !(value.base_revision === null || typeof value.base_revision === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.base_revision))
    || !['ready', 'unavailable', 'not_git'].includes(value.state)
    || !Array.isArray(value.files) || value.files.length > WORKSPACE_FILE_LIMIT
    || !count(value.additions) || !count(value.deletions) || !count(value.hidden_files)
    || typeof value.patch !== 'string' || value.patch.length > WORKSPACE_PATCH_LIMIT
    || typeof value.patch_truncated !== 'boolean') return null;
  if (new TextEncoder().encode(JSON.stringify(value)).length > 480 * 1024) return null;
  const files = [];
  const paths = new Set();
  for (const file of value.files) {
    if (!exact(file, ['path', 'previous_path', 'status', 'additions', 'deletions', 'binary'])
      || !path(file.path) || paths.has(file.path)
      || !(file.previous_path === null || path(file.previous_path)) || !states.includes(file.status)
      || !count(file.additions) || !count(file.deletions) || typeof file.binary !== 'boolean') return null;
    paths.add(file.path);
    files.push({ path: file.path, previous_path: file.previous_path, status: file.status,
      additions: file.additions, deletions: file.deletions, binary: file.binary });
  }
  if (value.state !== 'ready' && (files.length || value.additions || value.deletions || value.hidden_files || value.patch || value.patch_truncated)) return null;
  if (files.reduce((n, file) => n + file.additions, 0) > value.additions
    || files.reduce((n, file) => n + file.deletions, 0) > value.deletions) return null;
  return { captured_at: new Date(value.captured_at).toISOString(), branch: value.branch,
    base_revision: value.base_revision, state: value.state, files, additions: value.additions,
    deletions: value.deletions, hidden_files: value.hidden_files, patch: value.patch,
    patch_truncated: value.patch_truncated };
}

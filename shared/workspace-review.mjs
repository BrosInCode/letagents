import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { parseWorkspaceChangeSummary } from './workspace-change-summary.mjs';

// Full review bytes travel separately from the bounded room timeline.
export const REVIEW_LIMIT = 128 * 1024 * 1024;
export const REVIEW_PAGE_SIZE = 64 * 1024;
export const REVIEW_MAX_PAGES = REVIEW_LIMIT / REVIEW_PAGE_SIZE;
export function parseWorkspaceReview(value) {
  if (!value || value.version !== 1 || Object.keys(value).sort().join(',') !== 'contribution,version,workspace') return null;
  const workspace = parseWorkspaceChangeSummary(value.workspace, true);
  const contribution = parseWorkspaceChangeSummary(value.contribution, true);
  if (!workspace || !contribution) return null;
  return { version: 1, workspace, contribution };
}
export function encodeWorkspaceReview(value) {
  const parsed = parseWorkspaceReview(value);
  if (!parsed) throw new Error('Invalid full workspace review.');
  const json = JSON.stringify(parsed);
  if (Buffer.byteLength(json) > REVIEW_LIMIT) throw new RangeError('Workspace review exceeds capture capacity.');
  const data = gzipSync(json).toString('base64');
  if (data.length > REVIEW_LIMIT) throw new RangeError('Workspace review exceeds transfer capacity.');
  return { data, digest: createHash('sha256').update(data).digest('hex') };
}
export function decodeWorkspaceReview(data, digest) {
  if (typeof data !== 'string' || data.length > REVIEW_LIMIT || createHash('sha256').update(data).digest('hex') !== digest) throw new Error('Incomplete workspace review.');
  const value = parseWorkspaceReview(JSON.parse(gunzipSync(Buffer.from(data, 'base64'), { maxOutputLength: REVIEW_LIMIT }).toString('utf8')));
  if (!value) throw new Error('Invalid workspace review.');
  return value;
}
export function parseWorkspaceReviewPage(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'data,digest,index,total'
    || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)
    || !Number.isSafeInteger(value.total) || value.total < 1 || value.total > REVIEW_MAX_PAGES
    || !Number.isSafeInteger(value.index) || value.index < 0 || value.index >= value.total
    || typeof value.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)
    || value.data.length > REVIEW_PAGE_SIZE || (value.index < value.total - 1 && value.data.length !== REVIEW_PAGE_SIZE)) return null;
  return { digest: value.digest, index: value.index, total: value.total, data: value.data };
}

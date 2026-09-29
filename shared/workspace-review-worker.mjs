import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { decodeWorkspaceReview, parseWorkspaceReviewPage } from './workspace-review.mjs';
import { createWorkspaceDiffIndex, readWorkspaceDiffPage } from './workspace-diff.mjs';

let review = null;
let pages = [], digest = '', total = 0;
const indexes = new Map();
const describe = () => ({ version: 1, workspace: { ...review.workspace, patch: '' }, contribution: { ...review.contribution, patch: '' } });
parentPort.on('message', ({ id, method, input }) => {
  try {
    let result;
    if (method === 'local') {
      let db;
      try {
        db = new DatabaseSync(input.databasePath, { readOnly: true });
        const row = db.prepare(`SELECT r.data,r.digest FROM room_workspace_reviews r JOIN room_work_publications p
          USING(agent_id,room_id,source_message_id) WHERE p.room_id=? AND p.agent_key=? AND p.source_message_id=? AND p.api_origin=? AND p.state='open'`)
          .get(input.roomId, input.agentKey, input.sourceMessageId, input.apiOrigin);
        if (row) review = decodeWorkspaceReview(String(row.data), String(row.digest));
      } catch { review = null; } finally { db?.close(); }
      result = review ? describe() : null;
    } else if (method === 'append') {
      if (!Array.isArray(input) || input.length > 4) throw new Error('Invalid review pages.');
      if (!pages.length) { review = null; indexes.clear(); }
      for (const raw of input) {
        const page = parseWorkspaceReviewPage(raw);
        if (!page || page.index !== pages.length || (pages.length && (page.digest !== digest || page.total !== total))) throw new Error('Incomplete workspace review.');
        digest = page.digest; total = page.total; pages.push(page.data);
      }
      result = null;
    } else if (method === 'finish') {
      if (!total || pages.length !== total) throw new Error('Incomplete workspace review.');
      const data = pages.join(''); pages = [];
      review = decodeWorkspaceReview(data, digest);
      result = describe();
    } else if (method === 'page') {
      if (!review || !['workspace', 'contribution'].includes(input.view) || typeof input.path !== 'string') throw new Error('Review is not open.');
      if (!indexes.has(input.view)) {
        const snapshot = review[input.view];
        indexes.set(input.view, createWorkspaceDiffIndex(snapshot.patch, snapshot.files));
      }
      result = readWorkspaceDiffPage(indexes.get(input.view), input.path, input);
    } else throw new Error('Invalid review operation.');
    parentPort.postMessage({ id, result });
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});

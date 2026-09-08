import { parentPort, workerData } from 'node:worker_threads';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { captureWorkspaceTree, captureWorkspacePair } from './workspace-turn-capture.mjs';
import { encodeWorkspaceReview, REVIEW_PAGE_SIZE } from './workspace-review.mjs';

// Git inspection and archive encoding never occupy the MCP transport's thread.
// A process runs at most one capture worker; only small metadata crosses IPC.
try {
  const { capture, directory, text } = workerData;
  const identity = `mcp-workspace:${capture.capture_id}`;
  if (workerData.operation === 'begin') {
    parentPort.postMessage({ baseline: await captureWorkspaceTree(capture.workspace, identity) });
  } else {
    const pair = await captureWorkspacePair(capture.workspace, capture.base_revision, capture.baseline, `${identity}:${capture.preparation_id}`);
    pair.contribution.summary = text;
    const { review, ...preview } = pair;
    const summary = { version: 3, recorded_state: 'completed', evidence_incomplete: true, elapsed_ms: null,
      operation_counts: { unresolved: 0, succeeded: 0, failed: 0, denied_before_start: 0,
        cancelled_before_start: 0, interrupted_after_start: 0, lost_after_start: 0 }, ...preview };
    let encoded = null;
    let warning = capture.baseline ? null : 'The starting snapshot is unavailable; no exact change attribution is available.';
    try { encoded = encodeWorkspaceReview(review); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
      warning = 'This capture exceeds the full-review size limit. Only its bounded preview is available.';
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (encoded) {
      await writeFile(join(directory, 'review.tmp'), encoded.data, { mode: 0o600 });
      await rename(join(directory, 'review.tmp'), join(directory, 'review'));
    }
    const prepared = { summary, text, warning,
      archive: encoded ? { digest: encoded.digest, length: encoded.data.length, total: Math.ceil(encoded.data.length / REVIEW_PAGE_SIZE) } : null };
    await writeFile(join(directory, 'prepared.tmp'), JSON.stringify(prepared), { mode: 0o600 });
    await rename(join(directory, 'prepared.tmp'), join(directory, 'prepared.json'));
    parentPort.postMessage({ prepared: true });
  }
} catch {
  parentPort.postMessage({ error: 'Workspace capture could not finish. Retry with the same capture_id.' });
}

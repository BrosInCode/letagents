import { parentPort, workerData } from 'node:worker_threads';
import { captureWorkspaceTree, captureWorkspacePair } from './workspace-turn-capture.mjs';

// Only filesystem/Git observation leaves the daemon. Authority and persistence
// remain with the caller, which waits for this immutable boundary before ACK.
try {
  const remoteTips = workerData.operation === 'settle'
    ? new Promise(resolve => parentPort.once('message', resolve)) : null;
  const result = workerData.operation === 'begin'
    ? await captureWorkspaceTree(...workerData.args)
    : await captureWorkspacePair(...workerData.args.slice(0, 5), remoteTips, workerData.args[5] ?? null);
  parentPort.postMessage({ result });
} catch {
  parentPort.postMessage({ error: 'Workspace observation failed.' });
}

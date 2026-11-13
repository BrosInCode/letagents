import { parentPort, workerData } from 'node:worker_threads';
import { captureWorkspaceTree, captureSettledWorkspace, compareSettledTurn } from './workspace-turn-capture.mjs';

// Only filesystem/Git observation leaves the daemon. Authority and persistence
// remain with the caller, which waits for this immutable boundary before ACK.
// No operation waits for a remote: the caller holds its capture queue while one
// runs. `settle` pins the settled files; `compare` gets the remotes' answer.
const operations = { begin: captureWorkspaceTree, settle: captureSettledWorkspace, compare: compareSettledTurn };
try {
  parentPort.postMessage({ result: await operations[workerData.operation](...workerData.args) });
} catch {
  parentPort.postMessage({ error: 'Workspace observation failed.' });
}

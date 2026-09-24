// In-process evidence owned by an adapter that rejected a native acquisition.
// Keep the original error/diagnostic and do not serialize an operational receipt
// through provider-authored text, IPC, or a returned successful handle.
const failures = new WeakMap();

export function providerAcquisitionIdentity(provider, request, continuationId = null) {
  const identity = { provider, workAttemptId: request.workAttemptId, roomId: request.roomId,
    entryId: request.supervisorEntryId, executionGenerationId: request.supervisorExecutionGenerationId,
    continuationId };
  if (Object.entries(identity).some(([key, value]) => key !== 'continuationId'
    && (typeof value !== 'string' || !value))) return null;
  return Object.freeze(identity);
}

export function retainProviderAcquisitionEvidence(error, identity, connection, terminal) {
  if (!(error instanceof Error) || !identity || !terminal.nativeRuntimeDeath) return;
  // One immutable receipt per rejection. A reused error must never be retargeted.
  if (failures.has(error)) throw new Error('Failed provider acquisition already has evidence.');
  failures.set(error, Object.freeze({ identity,
    connection: Object.freeze({ ...connection }),
    terminal: Object.freeze({ ...terminal,
      nativeRuntimeDeath: Object.freeze({ ...terminal.nativeRuntimeDeath }) }) }));
}

export function providerAcquisitionEvidence(error, expected) {
  const evidence = error instanceof Error ? failures.get(error) : undefined;
  if (!evidence) return undefined;
  if (!expected || Object.keys(evidence.identity).some(key => evidence.identity[key] !== expected[key])
    || (expected.continuationId !== null && evidence.terminal.providerContinuationId !== expected.continuationId)) {
    throw new Error('Failed provider acquisition evidence does not match the active launch.');
  }
  return evidence;
}

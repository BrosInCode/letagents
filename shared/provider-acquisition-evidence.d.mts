import type { NativeRuntimeDeath } from '../apps/desktop/shared/execution-protocol.js';

type Identity = Readonly<{ provider: string; workAttemptId: string; roomId: string;
  entryId: string; executionGenerationId: string; continuationId: string | null }>;
type Connection = { kind: 'claude_cli'; pid: number | null; processIdentity?: string | null };
type Terminal = { nativeRuntimeDeath?: NativeRuntimeDeath; endedAt: string; exitCode: number | null;
  signal: string | null; terminalCause: 'exited' | 'killed' | 'stopped' | 'crashed' | 'protocol_error' | 'provider_quota';
  providerContinuationId: string | null };
export function providerAcquisitionIdentity(provider: string,
  request: { workAttemptId: string; roomId: string; supervisorEntryId?: string; supervisorExecutionGenerationId?: string },
  continuationId?: string | null): Identity | null;
export function retainProviderAcquisitionEvidence(error: unknown, identity: Identity | null,
  connection: Connection, terminal: Terminal): void;
export function providerAcquisitionEvidence(error: unknown, expected: Identity | null):
  Readonly<{ identity: Identity; connection: Readonly<Connection>; terminal: Readonly<Terminal> }> | undefined;

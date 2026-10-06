import { parseTypingReport, TYPING } from '../../../../../shared/room-typing.mjs';
import { apiFetch } from '../auth.js';
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from './local-store.js';

export async function reportDesktopRoomTyping(identifier: string, raw: unknown): Promise<void> {
  const input = parseTypingReport(raw);
  if (!input || !identifier?.trim()) return;
  const storage = await resolveLocalAwareRoomStorageMode(identifier);
  if (storage.effectiveMode === 'local') return;
  await apiFetch(`/rooms/${encodeURIComponent(cloudRoomIdentifierForStorage(storage, identifier))}/typing`,
    { method: 'POST', body: JSON.stringify(input) }, { credential: 'app', timeoutMs: TYPING.interval });
}

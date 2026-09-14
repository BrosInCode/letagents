import type { KnowledgePage, KnowledgeRecord } from '../../../../shared/room-knowledge.mjs';
export interface DesktopAttentionTask { id: string; title: string; status: string; description: string | null; updated_at: string }
export interface DesktopAttentionRoom extends KnowledgePage { roomIdentifier: string; displayName: string; tasks: DesktopAttentionTask[] }
export interface DesktopNeedsYou { rooms: DesktopAttentionRoom[]; failures: Array<{ roomIdentifier: string; displayName: string }>; limited: boolean; cloudUnavailable: boolean; signedOut: boolean }
export type { KnowledgeRecord };

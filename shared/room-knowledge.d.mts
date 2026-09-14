export type KnowledgeType = 'memory' | 'attention';
export type MemoryCategory = 'goal' | 'decision' | 'constraint' | 'term' | 'reference';
export type AttentionCategory = 'question' | 'decision' | 'approval' | 'review';
export interface KnowledgeActor { id: string; label: string; kind: 'human' | 'agent' }
export interface KnowledgeInput {
  category: MemoryCategory | AttentionCategory; title: string; body: string;
  recommendation?: string; unblocks?: string; source_url?: string; source_message_id?: string;
}
export interface KnowledgeRecord extends Required<KnowledgeInput> {
  id: string; room_id: string; type: KnowledgeType; version: number;
  author: KnowledgeActor; updated_by: KnowledgeActor; created_at: string; updated_at: string; archived: boolean;
  response: { body: string; actor: KnowledgeActor; at: string } | null;
}
export interface KnowledgePage { records: KnowledgeRecord[]; truncated: boolean }
export interface KnowledgeRevisionInput extends Partial<KnowledgeInput> { expected_version: number; response?: string; archived?: boolean }
export const MEMORY_CATEGORIES: MemoryCategory[];
export const ATTENTION_CATEGORIES: AttentionCategory[];
export class RoomKnowledgeError extends Error { status: number; constructor(message: string, status?: number) }
export function parseKnowledgeInput(type: KnowledgeType, value: unknown): Required<KnowledgeInput>;
export function knowledgeId(value: unknown): string;
export function createKnowledgeRecord(room_id: string, type: KnowledgeType, input: KnowledgeInput & { client_id: string }, author: KnowledgeActor, now?: string): KnowledgeRecord;
export function reviseKnowledgeRecord(record: KnowledgeRecord, input: KnowledgeRevisionInput, actor: KnowledgeActor, now?: string): KnowledgeRecord;
export function assertKnowledgeReplay(existing: KnowledgeRecord, candidate: KnowledgeRecord): void;

export function formatAttentionResponse(record: KnowledgeRecord): string;

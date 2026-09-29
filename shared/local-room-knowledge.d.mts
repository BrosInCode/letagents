import type { KnowledgePage, KnowledgeRecord, KnowledgeType } from './room-knowledge.mjs';
export interface KnowledgeDatabase { exec(sql: string): void; prepare(sql: string): { get(...args: unknown[]): any; all(...args: unknown[]): any[]; run(...args: unknown[]): unknown } }
export function initializeRoomKnowledge(db: KnowledgeDatabase): void;
export function listLocalKnowledge(db: KnowledgeDatabase, roomId: string, type: KnowledgeType): KnowledgePage;
export function getLocalKnowledge(db: KnowledgeDatabase, roomId: string, id: string): KnowledgeRecord | null;
export function localKnowledgeHistory(db: KnowledgeDatabase, roomId: string, id: string): KnowledgeRecord[];
export function saveLocalKnowledge(db: KnowledgeDatabase, record: KnowledgeRecord, expectedVersion?: number): KnowledgeRecord;

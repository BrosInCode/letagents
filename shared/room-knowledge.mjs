export const MEMORY_CATEGORIES = ['goal', 'decision', 'constraint', 'term', 'reference'];
export const ATTENTION_CATEGORIES = ['question', 'decision', 'approval', 'review'];

export class RoomKnowledgeError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function text(value, name, max, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new RoomKnowledgeError(`${name} must be ${required ? 'nonempty text' : 'text'} of at most ${max} characters.`);
  }
  return value.trim();
}

export function parseKnowledgeInput(type, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RoomKnowledgeError('A record is required.');
  const categories = type === 'memory' ? MEMORY_CATEGORIES : type === 'attention' ? ATTENTION_CATEGORIES : [];
  if (!categories.includes(value.category)) throw new RoomKnowledgeError('Choose a valid category.');
  const source_url = text(value.source_url, 'Source URL', 2048);
  if (source_url) {
    let url;
    try { url = new URL(source_url); } catch { throw new RoomKnowledgeError('Source URL must be an HTTP or HTTPS link.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new RoomKnowledgeError('Source URL must be an HTTP or HTTPS link without credentials.');
  }
  const source_message_id = text(value.source_message_id, 'Source message', 40);
  if (source_message_id && (!/^msg_[1-9]\d{0,9}$/.test(source_message_id) || Number(source_message_id.slice(4)) > 2147483647)) throw new RoomKnowledgeError('Invalid source message.');
  return {
    category: value.category,
    title: text(value.title, 'Title', 160, true),
    body: text(value.body, 'Context', 8000, true),
    recommendation: type === 'attention' ? text(value.recommendation, 'Recommendation', 2000) : '',
    unblocks: type === 'attention' ? text(value.unblocks, 'What this unblocks', 1000) : '',
    source_url,
    source_message_id,
  };
}

export function knowledgeId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(value)) throw new RoomKnowledgeError('Use a stable client ID of 8–80 letters, numbers, underscores or hyphens.');
  return value;
}

export function createKnowledgeRecord(room_id, type, input, author, now = new Date().toISOString()) {
  return { ...parseKnowledgeInput(type, input), id: knowledgeId(input.client_id), room_id, type,
    version: 1, author, updated_by: author, created_at: now, updated_at: now,
    archived: false, response: null };
}

export function reviseKnowledgeRecord(record, input, actor, now = new Date().toISOString()) {
  if (input.expected_version !== record.version) throw new RoomKnowledgeError('This changed since you opened it. Refresh to see the latest version.', 409);
  if (actor.kind !== 'human') throw new RoomKnowledgeError('Only a human can revise shared memory or answer a request.', 403);
  if (record.type === 'attention') {
    if (record.response) throw new RoomKnowledgeError('This request has already been answered.', 409);
    return { ...record, version: record.version + 1, updated_at: now, updated_by: actor,
      response: { body: text(input.response, 'Response', 8000, true), actor, at: now } };
  }
  if (input.archived !== undefined && typeof input.archived !== 'boolean') throw new RoomKnowledgeError('Archived must be true or false.');
  const content = input.archived !== undefined ? {} : parseKnowledgeInput('memory', input);
  return { ...record, ...content, archived: input.archived ?? record.archived,
    version: record.version + 1, updated_at: now, updated_by: actor };
}

export function assertKnowledgeReplay(existing, candidate) {
  const keys = ['type', 'category', 'title', 'body', 'recommendation', 'unblocks', 'source_url', 'source_message_id'];
  if (existing.author.id !== candidate.author.id || existing.author.kind !== candidate.author.kind || keys.some(key => existing[key] !== candidate[key])) {
    throw new RoomKnowledgeError('This client ID was already used for different content. Use a new ID for a new record.', 409);
  }
}

export function formatAttentionResponse(record) {
  const handle = record.author.kind === 'agent' ? record.author.id.trim().replace(/[A-Z]/g, c => c.toLowerCase()).replace(/[^a-z0-9_.:/-]+/g, '') : '';
  return `${handle ? `@agent:${handle}\n\n` : ''}Human response (${record.id}):\n\n${record.response.body}`;
}

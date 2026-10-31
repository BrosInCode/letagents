import { renderDesktopMarkdown } from "../formatting/markdown";
import { formatDate } from "../../../../domain/formatters";

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  return isToday
    ? formatDate("clockTime", date)
    : formatDate("monthDayTime2", date);
}

export function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

export function isAmbientSystemMessage(sender: string, text: string): boolean {
  const normalizedSender = String(sender || "").trim().toLowerCase();
  const normalizedText = String(text || "");
  return ["letagents", "system"].includes(normalizedSender)
    && /^\[status\]\s*/i.test(normalizedText)
    && !/\b(stale|blocked|failed|error|cannot|can't|cancelled)\b/i.test(normalizedText);
}

export function stripStatusPrefix(text: string): string {
  return String(text || "").replace(/^\[status\]\s*/i, "").trim();
}

export function renderMessageText(
  value: string,
  highlightQuery: string,
  messageReferenceIds?: ReadonlySet<string>,
  taskReferenceIds?: ReadonlySet<string>,
  onLink?: (url: string) => void,
): string {
  const rendered = renderDesktopMarkdown(value, { block: true, onLink });
  const linked = linkRenderedMessageReferences(rendered, messageReferenceIds, taskReferenceIds);
  return highlightRenderedMessage(linked, highlightQuery);
}

const messageOrTaskReference = /\b(?:msg|task)_\d+/;

/**
 * True when the HTML can hold a message or task reference at all. Callers use
 * it to skip the link pass, and to avoid reading the reference sets (so a
 * message with no references never depends on them).
 */
export function mayContainMessageReference(html: string): boolean {
  return messageOrTaskReference.test(html);
}

/** Decorate only HTML already escaped by renderMessageText. */
export function linkRenderedMessageReferences(
  html: string,
  messageReferenceIds?: ReadonlySet<string>,
  taskReferenceIds?: ReadonlySet<string>,
): string {
  if (!mayContainMessageReference(html)) return html;
  return linkTaskReferences(linkMessageReferences(html, messageReferenceIds), taskReferenceIds);
}

// One query is highlighted across every mounted message, so the compiled
// patterns are kept for the latest query only. A new query replaces them.
let highlightPatternQuery: string | null = null;
let highlightPattern: RegExp | null = null;
let highlightProbe: RegExp | null = null;

/** Counts RegExp builds so tests can prove one query builds one pattern. */
export const highlightPatternBuilds = { count: 0 };

function patternsForQuery(query: string): { pattern: RegExp; probe: RegExp } {
  if (highlightPatternQuery !== query || !highlightPattern || !highlightProbe) {
    const source = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    highlightPattern = new RegExp(source, "gi");
    highlightProbe = new RegExp(source, "i");
    highlightPatternQuery = query;
    highlightPatternBuilds.count += 1;
  }
  return { pattern: highlightPattern, probe: highlightProbe };
}

export function highlightRenderedMessage(html: string, highlightQuery: string): string {
  const normalizedQuery = highlightQuery.trim();
  if (!normalizedQuery) return html;
  const { pattern, probe } = patternsForQuery(normalizedQuery);
  // A query without an HTML-escaped character appears verbatim in the escaped
  // HTML whenever it appears in the visible text. Skip the full pass when it
  // does not appear at all. A false positive (a match inside a tag) only
  // costs the full pass.
  if (!/[&<>"]/.test(normalizedQuery) && !probe.test(html)) return html;
  const chunks = html.split(/(<[^>]+>)/g);
  const codeStack: string[] = [];
  let changed = false;
  const result = chunks.map((chunk) => {
    if (!chunk) return "";
    if (chunk.startsWith("<") && chunk.endsWith(">")) {
      updateSingleTagStack(codeStack, chunk, "code");
      return chunk;
    }
    if (codeStack.length) return chunk;
    const highlighted = highlightEscapedTextChunk(chunk, pattern);
    if (highlighted !== chunk) changed = true;
    return highlighted;
  });
  return changed ? result.join("") : html;
}

const markOpen = '<mark class="message-search-hit">';
const entityAt = /&(amp|lt|gt|quot);/iy;

function highlightEscapedTextChunk(chunk: string, pattern: RegExp): string {
  if (chunk.indexOf("&") === -1) {
    // No entities: the decoded text is the chunk, so mark matches in place.
    return chunk.replace(pattern, (match) => (match ? `${markOpen}${match}</mark>` : match));
  }
  const decodedChars: string[] = [];
  const encoded: string[] = [];
  for (let index = 0; index < chunk.length;) {
    entityAt.lastIndex = index;
    const entityMatch = entityAt.exec(chunk);
    if (entityMatch) {
      decodedChars.push(decodeHtmlEntity(entityMatch[1]!.toLowerCase()));
      encoded.push(entityMatch[0]);
      index += entityMatch[0].length;
      continue;
    }
    decodedChars.push(chunk[index]!);
    encoded.push(chunk[index]!);
    index += 1;
  }

  const decoded = decodedChars.join("");
  pattern.lastIndex = 0;
  const starts = new Set<number>();
  const ends = new Set<number>();
  for (const match of decoded.matchAll(pattern)) {
    if (match.index === undefined || !match[0]) continue;
    starts.add(match.index);
    ends.add(match.index + match[0].length);
  }
  if (!starts.size) return chunk;

  let out = "";
  for (let index = 0; index < encoded.length; index += 1) {
    if (starts.has(index)) out += markOpen;
    out += encoded[index];
    if (ends.has(index + 1)) out += "</mark>";
  }
  return out;
}

function decodeHtmlEntity(entity: string): string {
  if (entity === "amp") return "&";
  if (entity === "lt") return "<";
  if (entity === "gt") return ">";
  return '"';
}

function linkMessageReferences(html: string, messageReferenceIds?: ReadonlySet<string>): string {
  if (!messageReferenceIds) return html;
  const chunks = html.split(/(<[^>]+>)/g);
  const skipStack: string[] = [];
  return chunks
    .map((chunk) => {
      if (!chunk) return "";
      if (chunk.startsWith("<") && chunk.endsWith(">")) {
        updateSkipStack(skipStack, chunk);
        return chunk;
      }
      if (skipStack.length) return chunk;
      return chunk.replace(/\bmsg_\d+\b/g, (messageId) => {
        if (!messageReferenceIds.has(messageId)) return messageId;
        return [
          '<button class="message-reference-link" type="button"',
          ` data-message-reference-id="${messageId}"`,
          ` title="Jump to ${messageId}">`,
          messageId,
          "</button>",
        ].join("");
      });
    })
    .join("");
}

function linkTaskReferences(html: string, taskReferenceIds?: ReadonlySet<string>): string {
  if (!taskReferenceIds) return html;
  const chunks = html.split(/(<[^>]+>)/g);
  const skipStack: string[] = [];
  return chunks
    .map((chunk) => {
      if (!chunk) return "";
      if (chunk.startsWith("<") && chunk.endsWith(">")) {
        updateSkipStack(skipStack, chunk);
        return chunk;
      }
      if (skipStack.length) return chunk;
      return chunk.replace(/\btask_\d+\b/g, (taskId) => {
        if (!taskReferenceIds.has(taskId)) return taskId;
        return [
          '<button class="message-reference-link task-reference-link" type="button"',
          ` data-task-reference-id="${taskId}"`,
          ` title="Open ${taskId} on the Board">`,
          taskId,
          "</button>",
        ].join("");
      });
    })
    .join("");
}

function updateSkipStack(skipStack: string[], tag: string): void {
  const tagMatch = /^<\/?\s*([A-Za-z0-9-]+)/.exec(tag);
  if (!tagMatch) return;
  const tagName = tagMatch[1]!.toLowerCase();
  if (!["a", "button", "code"].includes(tagName)) return;
  if (/^<\//.test(tag)) {
    const index = skipStack.lastIndexOf(tagName);
    if (index >= 0) skipStack.splice(index, 1);
    return;
  }
  if (!/\/\s*>$/.test(tag)) {
    skipStack.push(tagName);
  }
}

function updateSingleTagStack(stack: string[], tag: string, trackedTag: string): void {
  const tagMatch = /^<\/?\s*([A-Za-z0-9-]+)/.exec(tag);
  if (!tagMatch || tagMatch[1]!.toLowerCase() !== trackedTag) return;
  if (/^<\//.test(tag)) {
    if (stack.length) stack.pop();
    return;
  }
  if (!/\/\s*>$/.test(tag)) stack.push(trackedTag);
}

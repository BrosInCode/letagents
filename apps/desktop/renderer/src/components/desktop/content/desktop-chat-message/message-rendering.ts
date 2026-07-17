import { renderDesktopMarkdown } from "../formatting/markdown";

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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
): string {
  const rendered = renderDesktopMarkdown(value, { block: true });
  const linked = linkTaskReferences(linkMessageReferences(rendered, messageReferenceIds), taskReferenceIds);
  return highlightRenderedMessage(linked, highlightQuery);
}

function highlightRenderedMessage(html: string, highlightQuery: string): string {
  const normalizedQuery = highlightQuery.trim();
  if (!normalizedQuery) return html;
  const chunks = html.split(/(<[^>]+>)/g);
  const codeStack: string[] = [];
  return chunks.map((chunk) => {
    if (!chunk) return "";
    if (chunk.startsWith("<") && chunk.endsWith(">")) {
      updateSingleTagStack(codeStack, chunk, "code");
      return chunk;
    }
    if (codeStack.length) return chunk;
    return highlightEscapedTextChunk(chunk, normalizedQuery);
  }).join("");
}

function highlightEscapedTextChunk(chunk: string, query: string): string {
  const units: Array<{ decoded: string; encoded: string }> = [];
  for (let index = 0; index < chunk.length;) {
    const entityMatch = /^&(amp|lt|gt|quot);/i.exec(chunk.slice(index));
    if (entityMatch) {
      units.push({
        decoded: decodeHtmlEntity(entityMatch[1]!.toLowerCase()),
        encoded: entityMatch[0],
      });
      index += entityMatch[0].length;
      continue;
    }
    units.push({ decoded: chunk[index]!, encoded: chunk[index]! });
    index += 1;
  }

  const decoded = units.map((unit) => unit.decoded).join("");
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const starts = new Set<number>();
  const ends = new Set<number>();
  for (const match of decoded.matchAll(pattern)) {
    if (match.index === undefined || !match[0]) continue;
    starts.add(match.index);
    ends.add(match.index + match[0].length);
  }
  if (!starts.size) return chunk;

  return units.map((unit, index) => [
    starts.has(index) ? '<mark class="message-search-hit">' : "",
    unit.encoded,
    ends.has(index + 1) ? "</mark>" : "",
  ].join("")).join("");
}

function decodeHtmlEntity(entity: string): string {
  if (entity === "amp") return "&";
  if (entity === "lt") return "<";
  if (entity === "gt") return ">";
  return '"';
}

function linkMessageReferences(html: string, messageReferenceIds?: ReadonlySet<string>): string {
  if (!messageReferenceIds?.size) return html;
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
  if (!taskReferenceIds?.size) return html;
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

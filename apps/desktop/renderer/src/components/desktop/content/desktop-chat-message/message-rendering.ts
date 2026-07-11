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
): string {
  const rendered = renderDesktopMarkdown(value, { highlightQuery });
  return linkMessageReferences(rendered, messageReferenceIds);
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

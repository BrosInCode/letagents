export function displaySender(sender: string): string {
  const [name] = sender.split("|").map((part) => part.trim()).filter(Boolean);
  return name || "Unknown";
}

export function replyPreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

export function selectedTextQuoteBlock(selectionText: string, sourceMessageId?: string | null): string {
  const quoteText = selectionText.replace(/\r\n?/g, "\n").trim();
  if (!quoteText) return "";
  const quote = quoteText
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  const source = sourceMessageId?.trim();
  return source ? `${quote}\n\nSource message: ${source}` : quote;
}

export function applySelectedTextQuoteToDraft(
  draft: string,
  selectionText: string,
  sourceMessageId?: string | null,
): string {
  const quote = selectedTextQuoteBlock(selectionText, sourceMessageId);
  const text = draft.trim();
  if (!quote) return text;
  return text ? `${quote}\n\n${text}` : quote;
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

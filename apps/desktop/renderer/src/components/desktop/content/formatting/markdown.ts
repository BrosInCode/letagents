export interface DesktopMarkdownOptions {
  highlightQuery?: string;
  block?: boolean;
  mentions?: boolean;
}

export function renderDesktopMarkdown(value: string, options: DesktopMarkdownOptions = {}): string {
  if (options.block) return renderBlockMarkdown(value, options);
  return renderInlineMarkdown(value, options).replace(/\n/g, "<br>");
}

export function renderInlineMarkdown(value: string, options: DesktopMarkdownOptions = {}): string {
  return applyInlineFormatting(
    highlightEscapedText(escapeHtml(value), options.highlightQuery || ""),
    options,
  );
}

function renderBlockMarkdown(value: string, options: DesktopMarkdownOptions): string {
  const lines = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  function flushParagraph(): void {
    if (!paragraph.length) return;
    blocks.push(`<p>${renderInlineMarkdown(paragraph.join("\n"), options).replace(/\n/g, "<br>")}</p>`);
    paragraph = [];
  }

  function flushList(): void {
    if (!list.length) return;
    blocks.push(`<ul>${list.map((item) => `<li>${renderInlineMarkdown(item, options)}</li>`).join("")}</ul>`);
    list = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1]!.length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2]!, options)}</h${level}>`);
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]!);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks.join("");
}

function applyInlineFormatting(escapedValue: string, options: DesktopMarkdownOptions): string {
  let rendered = escapedValue
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/(https?:\/\/[^\s<"']+)/g, (_match, url: string) => {
      const safeHref = escapeAttr(url.replace(/&amp;/g, "&"));
      return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });

  if (options.mentions !== false) {
    rendered = rendered.replace(/(^|[\s(])@([A-Za-z0-9._-]+)/g, '$1<span class="mention-token">@$2</span>');
  }

  return rendered;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function highlightEscapedText(value: string, query: string): string {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return value;
  const escapedQuery = escapeHtml(normalizedQuery).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escapedQuery) return value;
  return value.replace(new RegExp(escapedQuery, "gi"), '<mark class="message-search-hit">$&</mark>');
}

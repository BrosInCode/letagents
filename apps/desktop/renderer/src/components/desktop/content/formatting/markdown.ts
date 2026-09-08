export interface DesktopMarkdownOptions {
  highlightQuery?: string;
  block?: boolean;
  mentions?: boolean;
}

const MAX_BLOCKQUOTE_DEPTH = 8;

export function renderDesktopMarkdown(value: string, options: DesktopMarkdownOptions = {}): string {
  if (options.block) return renderBlockMarkdown(value, options);
  return renderInlineMarkdown(value, options).replace(/\n/g, "<br>");
}

export function renderInlineMarkdown(value: string, options: DesktopMarkdownOptions = {}): string {
  const tokens: string[] = [];
  // File references are display text here. Only the receipt's verified file actions
  // may open a local workspace; never turn a path supplied in prose into a URL.
  let tokenized = value.replace(/\u0000/g, "").replace(/`([^`\n]+)`/g, (_match, code: string) =>
    markdownToken(tokens, `<code>${escapeHtml(localFileName(code) ?? code)}</code>`)
  );
  tokenized = tokenized.replace(/\[([^\]\n]+)\]\((<[^>\n]+>|[^)\n]+)\)/g, (match, label: string, target: string) => {
    const path = target.replace(/^<|>$/g, "");
    if (/^https?:\/\/[^\s]+$/.test(path)) {
      return markdownToken(tokens, `<a href="${escapeAttr(path)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
    }
    const filename = localFileName(path, true);
    return filename ? markdownToken(tokens, `<code>${escapeHtml(filename)}</code>`) : match;
  });
  tokenized = tokenized.replace(/(https?:\/\/[^\s<>"']+)/g, (_match, url: string) =>
    markdownToken(tokens, `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`)
  );
  // Web links and inline code are already protected by tokens. Match only file
  // paths in prose, preserving punctuation and leaving API routes alone.
  tokenized = tokenized.replace(/(^|[\s(])((?:file:\/\/\/|~?\/|\.\.?\/|[A-Za-z]:[\\/]|(?:[\w.-]+\/)+)[^\s<>"'`()[\]]+)/g, (match, before: string, path: string) => {
    const punctuation = path.match(/[.,;!?]+$/)?.[0] ?? "";
    const filename = localFileName(path.slice(0, path.length - punctuation.length));
    return filename ? before + markdownToken(tokens, `<code>${escapeHtml(filename)}</code>`) + punctuation : match;
  });
  let rendered = highlightEscapedText(escapeHtml(tokenized), options.highlightQuery || "");
  rendered = rendered
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");

  if (options.mentions !== false) {
    rendered = rendered.replace(/(^|[\s(])@([A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._-]+)*)/g, '$1<span class="mention-token">@$2</span>');
  }

  return restoreMarkdownTokens(rendered, tokens);
}

function localFileName(value: string, linked = false): string | null {
  const path = value.replace(/^file:\/\/\//i, "/");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) return null;
  if (!linked && !/^(?:~?[\\/]|\.\.?[\\/]|[A-Za-z]:[\\/]|[\w.-]+[\\/])/.test(path)) return null;
  if (/[\n\r<>`]/.test(path) || (!linked && /\s/.test(path))) return null;
  const name = path.split(/[\\/]/).at(-1)!;
  if (!linked && !/^(?:[^\s.][^\/]*\.[A-Za-z0-9_-]+|\.[A-Za-z0-9_.-]+)(?:#L\d+(?:C\d+)?|:\d+(?::\d+)?)?$/.test(name)) return null;
  if (!name || name.startsWith("#") || name.includes("\u0000")) return null;
  try { return decodeURIComponent(name); } catch { return name; }
}

function renderBlockMarkdown(value: string, options: DesktopMarkdownOptions, quoteDepth = 0): string {
  const lines = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = /^```([A-Za-z0-9_+-]*)\s*$/.exec(trimmed);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index]!.trim())) {
        code.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const language = fence[1] ? ` class="language-${escapeAttr(fence[1])}"` : "";
      blocks.push(`<pre><code${language}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2]!, options)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push("<hr>");
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index]!.trim())) {
        quote.push(lines[index]!.trim().replace(/^>\s?/, ""));
        index += 1;
      }
      const quoteBody = quoteDepth >= MAX_BLOCKQUOTE_DEPTH
        ? `<p>${renderInlineMarkdown(quote.map((value) => value.replace(/^>+\s?/, "")).join("\n"), options).replace(/\n/g, "<br>")}</p>`
        : renderBlockMarkdown(quote.join("\n"), options, quoteDepth + 1);
      blocks.push(`<blockquote>${quoteBody}</blockquote>`);
      continue;
    }

    const listMatch = listItem(line);
    if (listMatch) {
      const ordered = listMatch.ordered;
      const items: string[] = [];
      while (index < lines.length) {
        const item = listItem(lines[index]!);
        if (!item || item.ordered !== ordered) break;
        items.push(renderListItem(item.text, options));
        index += 1;
      }
      const tag = ordered ? "ol" : "ul";
      blocks.push(`<${tag}>${items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() && !startsMarkdownBlock(lines[index]!)) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    if (!paragraph.length) {
      paragraph.push(line);
      index += 1;
    }
    blocks.push(`<p>${renderInlineMarkdown(paragraph.join("\n"), options).replace(/\n/g, "<br>")}</p>`);
  }

  return blocks.join("");
}

function renderListItem(value: string, options: DesktopMarkdownOptions): string {
  const task = /^\[([ xX])\]\s+(.+)$/.exec(value);
  if (!task) return renderInlineMarkdown(value, options);
  const checked = task[1]!.toLowerCase() === "x" ? " checked" : "";
  return `<input class="markdown-task-checkbox" type="checkbox" disabled${checked}>${renderInlineMarkdown(task[2]!, options)}`;
}

function listItem(line: string): { ordered: boolean; text: string } | null {
  const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
  if (unordered) return { ordered: false, text: unordered[1]! };
  const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
  return ordered ? { ordered: true, text: ordered[1]! } : null;
}

function startsMarkdownBlock(line: string): boolean {
  const trimmed = line.trim();
  return /^```/.test(trimmed)
    || /^#{1,6}\s+/.test(trimmed)
    || /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)
    || /^>\s?/.test(trimmed)
    || Boolean(listItem(line));
}

function markdownToken(tokens: string[], html: string): string {
  const index = tokens.push(html) - 1;
  return `\u0000MD${index}\u0000`;
}

function restoreMarkdownTokens(value: string, tokens: string[]): string {
  return value.replace(/\u0000MD(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] || "");
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

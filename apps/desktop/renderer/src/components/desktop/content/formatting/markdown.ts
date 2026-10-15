import { Lexer, Tokenizer, type Token, type Tokens } from "marked";

import { desktopHighlighter } from "./code-highlighter";
import { sanitizeMarkdownHtml } from "./markdown-sanitize";

export interface DesktopMarkdownOptions {
  highlightQuery?: string;
  block?: boolean;
  mentions?: boolean;
  preservePaths?: boolean;
  onLink?: (url: string) => void;
}

const MAX_BLOCKQUOTE_DEPTH = 8;
const MAX_CONTAINER_DEPTH = 16;
const MAX_INDENT_COLUMNS = 64;

export function renderDesktopMarkdown(value: string, options: DesktopMarkdownOptions = {}): string {
  const html = options.block
    ? renderBlockMarkdown(value, options)
    : renderInlineMarkdown(value, options).replace(/\n/g, "<br>");
  return sanitizeMarkdownHtml(html);
}

export function renderInlineMarkdown(value: string, options: DesktopMarkdownOptions = {}): string {
  const tokens: string[] = [];
  const links = new Map<number, string>();
  const linkToken = (url: string, html: string) => {
    const token = markdownToken(tokens, html);
    links.set(tokens.length - 1, url);
    return token;
  };
  // File references are display text here. Only the receipt's verified file actions
  // may open a local workspace; never turn a path supplied in prose into a URL.
  let tokenized = value.replace(/\u0000/g, "").replace(/`([^`\n]+)`/g, (_match, code: string) =>
    markdownToken(tokens, `<code>${escapeHtml(options.preservePaths ? code : localFileName(code) ?? code)}</code>`)
  );
  tokenized = tokenized.replace(/\[([^\]\n]+)\]\((<[^>\n]+>|[^)\n]+)\)/g, (match, label: string, target: string) => {
    const path = target.replace(/^<|>$/g, "");
    if (/^https?:\/\/[^\s]+$/.test(path)) {
      return linkToken(path, `<a href="${escapeAttr(path)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
    }
    const filename = localFileName(path, true);
    return filename ? markdownToken(tokens, `<code>${escapeHtml(options.preservePaths ? path : filename)}</code>`) : match;
  });
  tokenized = tokenized.replace(/(https?:\/\/[^\s<>"']+)/g, (_match, url: string) =>
    linkToken(url, `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`)
  );
  // Web links and inline code are already protected by tokens. Match only file
  // paths in prose, preserving punctuation and leaving API routes alone.
  tokenized = tokenized.replace(/(^|[\s(])((?:file:\/\/\/|~?\/|\.\.?\/|[A-Za-z]:[\\/]|(?:[\w.-]+\/)+)[^\s<>"'`()[\]]+)/g, (match, before: string, path: string) => {
    if (options.preservePaths) return match;
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

  return restoreMarkdownTokens(rendered, tokens, (index) => {
    const url = links.get(index);
    if (url) options.onLink?.(url);
  });
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

// Block structure comes from marked's GFM lexer. Inline text is still rendered by
// renderInlineMarkdown so that links, file names, mentions, link collection and
// search highlight behave as before. Raw HTML in a message is shown as text.
class ChatTokenizer extends Tokenizer {
  private containerDepth = 0;

  // Chat text is often indented by accident. Four leading spaces must not turn a
  // paragraph into a code block; only fenced code is code.
  override code(): undefined {
    return undefined;
  }

  // marked lexes nested lists and quotes recursively. Hostile messages with
  // thousands of levels would overflow the stack, so deeper levels stay text.
  override list(src: string): Tokens.List | undefined {
    return this.nested(() => super.list(src));
  }

  override blockquote(src: string): Tokens.Blockquote | undefined {
    return this.nested(() => super.blockquote(src));
  }

  private nested<T>(lex: () => T): T | undefined {
    if (this.containerDepth >= MAX_CONTAINER_DEPTH) return undefined;
    this.containerDepth += 1;
    try {
      return lex();
    } finally {
      this.containerDepth -= 1;
    }
  }
}

const FENCE_LANGUAGE = /^[A-Za-z0-9_+-]*$/;

function renderBlockMarkdown(value: string, options: DesktopMarkdownOptions): string {
  const source = capIndentation(value.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  let tokens: Token[];
  try {
    // Block tokens only: inline text is rendered by renderInlineMarkdown below.
    tokens = new Lexer({ gfm: true, breaks: true, tokenizer: new ChatTokenizer() }).blockTokens(source, []);
  } catch {
    return `<p>${renderTextBlock(source, options)}</p>`;
  }
  return renderBlocks(tokens, options, 0);
}

// marked's list lexer re-scans deeply indented text level by level, so a message
// indented a little more on each line is quadratic. No real Markdown needs more
// than 64 columns of indentation; deeper indentation collapses to 64 spaces.
function capIndentation(source: string): string {
  return source.replace(/^[ \t]{17,}/gm, (indent) => {
    let columns = 0;
    for (const char of indent) columns += char === "\t" ? 4 : 1;
    return columns > MAX_INDENT_COLUMNS ? " ".repeat(MAX_INDENT_COLUMNS) : indent;
  });
}

function renderBlocks(tokens: readonly Token[], options: DesktopMarkdownOptions, quoteDepth: number): string {
  return tokens.map((token) => renderBlock(token, options, quoteDepth)).join("");
}

function renderBlock(token: Token, options: DesktopMarkdownOptions, quoteDepth: number): string {
  switch (token.type) {
    case "space":
      return "";
    case "code": {
      const code = token as Tokens.Code;
      const lang = (code.lang ?? "").trim().split(/\s+/)[0] ?? "";
      if (!FENCE_LANGUAGE.test(lang)) return `<p>${renderTextBlock(code.raw, options)}</p>`;
      return desktopHighlighter.renderCodeBlock(code.text, lang);
    }
    case "heading": {
      const heading = token as Tokens.Heading;
      const level = Math.min(Math.max(heading.depth, 1), 6);
      return `<h${level}>${renderTextBlock(heading.text, options)}</h${level}>`;
    }
    case "hr":
      return "<hr>";
    case "blockquote": {
      const quote = token as Tokens.Blockquote;
      const body = quoteDepth >= MAX_BLOCKQUOTE_DEPTH
        ? `<p>${renderTextBlock(quote.text.replace(/^[ \t]*(?:>[ \t]?)+/gm, ""), options)}</p>`
        : renderBlocks(quote.tokens, options, quoteDepth + 1);
      return `<blockquote>${body}</blockquote>`;
    }
    case "list":
      return renderList(token as Tokens.List, options, quoteDepth);
    case "table":
      return renderTable(token as Tokens.Table, options);
    case "paragraph":
      return `<p>${renderTextBlock((token as Tokens.Paragraph).text, options)}</p>`;
    case "text":
      return renderTextBlock((token as Tokens.Text).text, options);
    default:
      // html, def and any unknown block: show the source as text.
      return token.raw.trim() ? `<p>${renderTextBlock(token.raw, options)}</p>` : "";
  }
}

function renderList(list: Tokens.List, options: DesktopMarkdownOptions, quoteDepth: number): string {
  const tag = list.ordered ? "ol" : "ul";
  const startNumber = Number(list.start);
  const start = list.ordered && Number.isInteger(startNumber) && startNumber !== 1 ? ` start="${startNumber}"` : "";
  const items = list.items.map((item) => `<li>${renderListItem(item, options, quoteDepth)}</li>`).join("");
  return `<${tag}${start}>${items}</${tag}>`;
}

function renderListItem(item: Tokens.ListItem, options: DesktopMarkdownOptions, quoteDepth: number): string {
  const blocks = item.tokens.filter((token) => token.type !== "space" && token.type !== "checkbox");
  const checkbox = item.task
    ? `<input class="markdown-task-checkbox" type="checkbox" disabled${item.checked ? " checked" : ""}>`
    : "";
  return blocks.map((block, index) => {
    const isTextBlock = block.type === "paragraph" || block.type === "text";
    if (!isTextBlock) return renderBlock(block, options, quoteDepth);
    const text = (block as Tokens.Paragraph | Tokens.Text).text;
    const prefix = index === 0 ? checkbox : "";
    const inline = renderTextBlock(index === 0 && item.task ? text.replace(/^\s*\[[ xX]\][ \t]*/, "") : text, options);
    // A list item with one paragraph stays compact, as in a tight list.
    if (block.type === "text" || blocks.length === 1) return prefix + inline;
    return `<p>${prefix}${inline}</p>`;
  }).join("") || checkbox;
}

function renderTable(table: Tokens.Table, options: DesktopMarkdownOptions): string {
  const cell = (tag: "th" | "td", value: Tokens.TableCell) => {
    const align = value.align ? ` class="markdown-align-${value.align}"` : "";
    return `<${tag}${align}>${renderTextBlock(value.text, options)}</${tag}>`;
  };
  const head = `<thead><tr>${table.header.map((value) => cell("th", value)).join("")}</tr></thead>`;
  const body = table.rows.length
    ? `<tbody>${table.rows.map((row) => `<tr>${row.map((value) => cell("td", value)).join("")}</tr>`).join("")}</tbody>`
    : "";
  return `<div class="markdown-table-scroll"><table>${head}${body}</table></div>`;
}

/** Inline-render one block of source text: drop indentation, keep single newlines as breaks. */
function renderTextBlock(value: string, options: DesktopMarkdownOptions): string {
  const text = value
    .replace(/[ \t]+$/gm, "")
    .replace(/^[ \t]+/gm, "")
    .replace(/\n+$/, "");
  return renderInlineMarkdown(text, options).replace(/\n/g, "<br>");
}

function markdownToken(tokens: string[], html: string): string {
  const index = tokens.push(html) - 1;
  return `\u0000MD${index}\u0000`;
}

function restoreMarkdownTokens(value: string, tokens: string[], onToken: (index: number) => void): string {
  return value.replace(/\u0000MD(\d+)\u0000/g, (_match, index: string) => { onToken(Number(index)); return tokens[Number(index)] || ""; });
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

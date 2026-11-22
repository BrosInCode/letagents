import { renderMarkdown } from "../../../../../../../../shared/ui/markdown/markdown";
import { formatDate } from "../../../../domain/formatters";
import { linkRenderedMessageReferences } from "../../../../../../../../shared/ui/markdown/references";
import { normalizePreviewRepository } from "../../../../../../../../shared/message-link-previews.mjs";

export { isAmbientSystemMessage, stripStatusPrefix } from "../../../../../../../../shared/ui/room-messages";
export { linkRenderedMessageReferences, mayContainMessageReference } from "../../../../../../../../shared/ui/markdown/references";

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

export function renderMessageText(
  value: string,
  highlightQuery: string,
  messageReferenceIds?: ReadonlySet<string>,
  taskReferenceIds?: ReadonlySet<string>,
  onLink?: (url: string) => void,
): string {
  const rendered = renderMarkdown(value, { block: true, onLink });
  const linked = linkRenderedMessageReferences(rendered, messageReferenceIds, taskReferenceIds);
  return highlightRenderedMessage(linked, highlightQuery);
}

const gitHubReference = /\b(?:pr|pull request)\s*#([1-9]\d*)\b|\brun(?:\s+id)?[\s:]+#?([1-9]\d{6,})\b|(?<![\w/#@.-])(?:([\w.-]+\/[\w.-]+)@)?([a-f\d]{7,40})(?![\w/@-]|\.[\w.])/gi;
const runLabel = /\brun(?:\s+id)?\s*:?\s*$/i;
const pullRequestLabel = /\b(?:pr|pull request)\s*$/i;
const commitLabel = /\b(?:sha|commit|head|base)\s*[:=]?\s*$/i;

/** Link shorthand in escaped Markdown, including standalone refs in inline code. */
export function linkRenderedGitHubReferences(html: string, roomRepository: string | null): string {
  if (!/[a-f\d]{7,}|#\d/i.test(html)) return html;
  const repository = normalizePreviewRepository(roomRepository);
  if (!repository && !html.includes("@")) return html;
  const tokens = html.split(/(<code>[^<]*<\/code>|<[^>]+>)/g);
  let protectedTag: string | null = null;
  return tokens.map((token, index) => {
    if (protectedTag) {
      if (token === '</' + protectedTag + '>') protectedTag = null;
      return token;
    }
    const precedingText = tokens[index - 1]?.slice(-32) ?? "";
    if (token.startsWith("<code>") && token.endsWith("</code>")) {
      const code = token.slice(6, -7);
      let linked: string;
      if (repository && runLabel.test(precedingText) && /^#?[1-9]\d{6,}$/.test(code)) {
        linked = gitHubAnchor(repository, 'actions/runs', code.replace(/^#/, ""), code);
      } else if (repository && pullRequestLabel.test(precedingText) && /^#[1-9]\d*$/.test(code)) {
        linked = gitHubAnchor(repository, 'pull', code.slice(1), code);
      } else {
        const match = code.matchAll(gitHubReference).next().value;
        linked = match?.[0] === code
          ? linkGitHubReference(match[0], match[1], match[2], match[3], match[4], repository, precedingText)
          : code;
      }
      return '<code>' + linked + '</code>';
    }
    if (token.startsWith("<")) {
      protectedTag = /^<(a|button|pre|code)(?:\s|>)/.exec(token)?.[1] ?? null;
      return token;
    }
    return token.replace(gitHubReference, (label, pull, run, explicitRepository, sha, offset: number) =>
      linkGitHubReference(label, pull, run, explicitRepository, sha, repository, token.slice(Math.max(0, offset - 32), offset)));
  }).join("");
}

function linkGitHubReference(
  label: string, pull: string | undefined, run: string | undefined, explicitRepository: string | undefined,
  sha: string | undefined, repository: string | null, precedingText: string,
): string {
  const target = explicitRepository ? normalizePreviewRepository(explicitRepository) : repository;
  if (!target) return label;
  if (pull) return gitHubAnchor(target, 'pull', pull, label);
  if (run) return gitHubAnchor(target, 'actions/runs', run, label);
  if (sha && (sha.length === 40 || explicitRepository || commitLabel.test(precedingText) || /[a-f]/i.test(sha) && /\d/.test(sha))) {
    return gitHubAnchor(target, 'commit', sha, label);
  }
  return label;
}

function gitHubAnchor(repository: string, kind: "pull" | "actions/runs" | "commit", id: string, label: string): string {
  if (repository.split("/").some((part) => part === "." || part === "..")) return label;
  // The repository and id have already been constrained to GitHub path characters.
  return '<a href="https://github.com/' + repository + '/' + kind + '/' + id + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
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

function updateSingleTagStack(stack: string[], tag: string, trackedTag: string): void {
  const tagMatch = /^<\/?\s*([A-Za-z0-9-]+)/.exec(tag);
  if (!tagMatch || tagMatch[1]!.toLowerCase() !== trackedTag) return;
  if (/^<\//.test(tag)) {
    if (stack.length) stack.pop();
    return;
  }
  if (!/\/\s*>$/.test(tag)) stack.push(trackedTag);
}

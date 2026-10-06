// Searching a room's messages: the limits and the one query grammar that the
// server and both apps share. A query is a list of terms; a message matches
// when it contains every term, ignoring case. A term is a word, or a phrase
// in double quotes. Matching is by substring, so part of an identifier, a
// file path or an error string finds the message.

export const MESSAGE_SEARCH_MIN_QUERY_CHARS = 2;
export const MESSAGE_SEARCH_MAX_QUERY_CHARS = 200;
export const MESSAGE_SEARCH_MAX_TERMS = 6;
export const MESSAGE_SEARCH_DEFAULT_LIMIT = 30;
export const MESSAGE_SEARCH_MAX_LIMIT = 50;

/**
 * Split a query into its terms, or say why it cannot be searched.
 * Returns `{ terms }` or `{ error: "too_short" | "too_long" | "too_many_terms" }`.
 */
export function parseMessageSearchQuery(value) {
  const query = typeof value === "string" ? value.trim() : "";
  if (query.length > MESSAGE_SEARCH_MAX_QUERY_CHARS) return { error: "too_long" };

  const terms = [];
  const seen = new Set();
  // A phrase runs to its closing quote, or to the end when the quote is never closed.
  for (const match of query.matchAll(/"([^"]*)"?|(\S+)/g)) {
    const term = (match[1] ?? match[2] ?? "").replace(/\s+/g, " ").trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  if (terms.join("").length < MESSAGE_SEARCH_MIN_QUERY_CHARS) return { error: "too_short" };
  if (terms.length > MESSAGE_SEARCH_MAX_TERMS) return { error: "too_many_terms" };
  return { terms };
}

/** Whether a text contains every term, the same test the server applies. */
export function textMatchesMessageSearch(text, terms) {
  const haystack = String(text ?? "").toLowerCase();
  return terms.length > 0 && terms.every((term) => haystack.includes(term.toLowerCase()));
}

function matchRanges(text, terms) {
  const lower = text.toLowerCase();
  // Lowercasing can expand a character (İ -> i + combining dot). Keep the
  // original UTF-16 boundaries so highlights and snippets still slice source text.
  let sourceOffsets = null;
  if (lower.length !== text.length) {
    sourceOffsets = [];
    let start = 0;
    for (const character of text) {
      const end = start + character.length;
      for (let index = 0; index < character.toLowerCase().length; index += 1) {
        sourceOffsets.push([start, end]);
      }
      start = end;
    }
    // Context-sensitive casing must not leave offsets outside the map.
    if (sourceOffsets.length !== lower.length) return [];
  }
  const ranges = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (!needle) continue;
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
      ranges.push(sourceOffsets
        ? [sourceOffsets[at][0], sourceOffsets[at + needle.length - 1][1]]
        : [at, at + needle.length]);
    }
  }
  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  // Overlapping and touching matches read as one highlighted run.
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/**
 * Split a text into runs that do and do not match the terms, for rendering
 * highlights as plain text nodes (never as HTML).
 */
export function highlightMessageSearchText(text, terms) {
  const source = String(text ?? "");
  const segments = [];
  let cursor = 0;
  for (const [start, end] of matchRanges(source, terms)) {
    if (start > cursor) segments.push({ text: source.slice(cursor, start), match: false });
    segments.push({ text: source.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < source.length) segments.push({ text: source.slice(cursor), match: false });
  return segments;
}

/**
 * A short excerpt around the first match: whitespace collapsed, cut at
 * `maxLength` characters, with an ellipsis where text was left out.
 */
export function messageSearchSnippet(text, terms, maxLength = 220) {
  const source = String(text ?? "").replace(/\s+/g, " ").trim();
  if (source.length <= maxLength) return source;
  const first = matchRanges(source, terms)[0]?.[0] ?? 0;
  // Keep a little lead-in so the match is read in its sentence.
  let start = Math.max(0, Math.min(first - Math.floor(maxLength / 4), source.length - maxLength));
  if (start > 0) {
    const space = source.indexOf(" ", start);
    if (space !== -1 && space < first) start = space + 1;
  }
  const end = Math.min(source.length, start + maxLength);
  return `${start > 0 ? "…" : ""}${source.slice(start, end).trim()}${end < source.length ? "…" : ""}`;
}

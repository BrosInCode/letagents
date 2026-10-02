export const MESSAGE_SEARCH_MIN_QUERY_CHARS: 2;
export const MESSAGE_SEARCH_MAX_QUERY_CHARS: 200;
export const MESSAGE_SEARCH_MAX_TERMS: 6;
export const MESSAGE_SEARCH_DEFAULT_LIMIT: 30;
export const MESSAGE_SEARCH_MAX_LIMIT: 50;

export type MessageSearchQueryError = "too_short" | "too_long" | "too_many_terms";

export type ParsedMessageSearchQuery =
  | { terms: string[]; error?: undefined }
  | { error: MessageSearchQueryError; terms?: undefined };

/**
 * Split a query into its terms, or say why it cannot be searched. A term is a
 * word, or a phrase in double quotes; a message matches when it contains every
 * term as a substring, ignoring case.
 */
export function parseMessageSearchQuery(value: unknown): ParsedMessageSearchQuery;

/** Whether a text contains every term, the same test the server applies. */
export function textMatchesMessageSearch(text: unknown, terms: readonly string[]): boolean;

/** `GET /rooms/:room/messages/search` */
export interface MessageSearchResponse<Message = unknown> {
  room_id: string;
  terms: string[];
  /** Newest first. */
  messages: Message[];
  has_more: boolean;
  /** Pass as `before` to read the next, older page; null on the last page. */
  next_before: string | null;
}

export interface MessageSearchSegment {
  text: string;
  match: boolean;
}

/**
 * Split a text into runs that do and do not match the terms, for rendering
 * highlights as plain text nodes (never as HTML).
 */
export function highlightMessageSearchText(text: unknown, terms: readonly string[]): MessageSearchSegment[];

/** A short excerpt around the first match, with an ellipsis where text was left out. */
export function messageSearchSnippet(text: unknown, terms: readonly string[], maxLength?: number): string;

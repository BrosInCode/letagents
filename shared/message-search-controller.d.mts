import type { MessageSearchQueryError, MessageSearchResponse } from "./message-search.mjs";

export const MESSAGE_SEARCH_DEBOUNCE_MS: 250;

export interface MessageSearchState<Hit extends { id: string }> {
  /**
   * `idle`: nothing to search yet. `invalid`: the query breaks a limit (see `error`).
   * `loading`: the first page is on its way. `ready` / `error`: it arrived, or failed.
   */
  status: "idle" | "invalid" | "loading" | "ready" | "error";
  terms: readonly string[];
  /** Newest first. */
  hits: readonly Hit[];
  hasMore: boolean;
  loadingMore: boolean;
  /** A query limit name when `invalid`; otherwise the last request's failure, if any. */
  error: MessageSearchQueryError | string | null;
}

export interface MessageSearchController<Hit extends { id: string }> {
  readonly state: MessageSearchState<Hit>;
  /** Search for a new query after a short pause in typing. */
  setQuery(value: string): void;
  /** Read the next, older page of the current results. */
  loadMore(): Promise<void>;
  /** Stop searching; call when the search closes or the room changes. */
  reset(): void;
}

/**
 * The client-side state of one room's history search, shared by the desktop
 * and web apps. Answers that arrive for an earlier query are dropped.
 */
export function createMessageSearchController<Hit extends { id: string }>(options: {
  search(query: string, before: string | null): Promise<Pick<MessageSearchResponse<Hit>, "messages" | "has_more" | "next_before"> & { terms?: string[] }>;
  onChange?(): void;
  debounceMs?: number;
}): MessageSearchController<Hit>;

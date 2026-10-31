import type { RoomGif } from "./room-expressions.mjs";
/** Ephemeral rendering data: never store this in messages, journals or logs. */
export interface GiphyItem extends RoomGif {
  page_url: string;
  preview_url: string | null;
  still_url: string | null;
  image_url: string | null;
}
export type GiphyResult = { ok: true; items: GiphyItem[]; next_offset: number | null }
  | { ok: false; code: string; message: string; retry_after_ms: number };
export declare function createGiphyClient(options?: { fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number }): {
  search(apiKey: string, query: string, offset?: number): Promise<GiphyResult>;
  resolve(apiKey: string, gifId: string): Promise<GiphyResult>;
};

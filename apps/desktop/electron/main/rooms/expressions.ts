import type { RoomExpressionsSetting } from "../../../../../shared/room-expressions.mjs";
import { createGiphyClient, type GiphyResult } from "../../../../../shared/giphy-client.mjs";
import { apiFetch } from "../auth.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";

const giphy = createGiphyClient();
async function roomPath(identifier: string): Promise<string> {
  if (!identifier?.trim()) throw new Error("Choose a room first.");
  const storage = await resolveLocalAwareRoomStorageMode(identifier);
  if (storage.effectiveMode === "local") throw new Error("GIFs and agent reactions require a cloud room.");
  return `/rooms/${encodeURIComponent(cloudRoomIdentifierForStorage(storage, identifier))}`;
}
export async function getDesktopExpressions(identifier: string): Promise<RoomExpressionsSetting> {
  return apiFetch<RoomExpressionsSetting>(`${await roomPath(identifier)}/expressions`);
}
export async function setDesktopExpressions(identifier: string, enabled: boolean): Promise<RoomExpressionsSetting> {
  if (typeof enabled !== "boolean") throw new Error("Choose whether expressions are enabled.");
  return apiFetch<RoomExpressionsSetting>(`${await roomPath(identifier)}/expressions`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
  });
}
export async function desktopGiphy(identifier: string, input: { query: string; offset?: number } | { id: string }): Promise<GiphyResult> {
  try {
    const config = await apiFetch<{ enabled: boolean; api_key: string | null }>(`${await roomPath(identifier)}/gif-client-config`, { signal: AbortSignal.timeout(4000) });
    if ("query" in input && !config.enabled) return { ok: false, code: "disabled", message: "GIF sending is off in this room.", retry_after_ms: 0 };
    // Electron is the end-user's client. This never goes through an API proxy,
    // and neither the API key nor a fetch exception crosses IPC to the renderer.
    return "query" in input ? giphy.search(config.api_key ?? "", input.query, input.offset) : giphy.resolve(config.api_key ?? "", input.id);
  } catch { return { ok: false, code: "unavailable", message: "GIFs are unavailable right now. You can send text instead.", retry_after_ms: 0 }; }
}

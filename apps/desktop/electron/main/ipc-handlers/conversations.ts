import type { IpcMain } from "electron";
import { apiFetch } from "../auth.js";

/** Explicit IPC methods keep renderer requests inside the conversation API. */
export function registerConversationIpcHandlers(ipc: IpcMain): void {
  const path = (id: string) => `/conversations/${encodeURIComponent(id)}`;
  ipc.handle("desktop:conversations:list", () => apiFetch("/conversations"));
  ipc.handle("desktop:conversations:people", (_event, query: string) =>
    apiFetch(`/conversations/people?q=${encodeURIComponent(query)}`),
  );
  ipc.handle(
    "desktop:conversations:create",
    (_event, ids: string[], from?: string) =>
      apiFetch("/conversations", {
        method: "POST",
        body: JSON.stringify({ account_ids: ids, from_conversation_id: from }),
      }),
  );
  ipc.handle(
    "desktop:conversations:messages",
    (_event, id: string, cursor?: { before?: number; after?: number }) => {
      const query = new URLSearchParams();
      if (cursor?.before !== undefined)
        query.set("before", String(cursor.before));
      if (cursor?.after !== undefined) query.set("after", String(cursor.after));
      return apiFetch(`${path(id)}/messages?${query}`);
    },
  );
  ipc.handle(
    "desktop:conversations:send",
    (_event, id: string, text: string, clientId: string) =>
      apiFetch(`${path(id)}/messages`, {
        method: "POST",
        body: JSON.stringify({ text, client_message_id: clientId }),
      }),
  );
  ipc.handle(
    "desktop:conversations:update",
    (_event, id: string, changes: object) =>
      apiFetch(path(id), { method: "PATCH", body: JSON.stringify(changes) }),
  );
  ipc.handle(
    "desktop:conversations:block",
    (_event, id: string, blocked: boolean) =>
      apiFetch(`/conversations/blocks/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({ blocked }),
      }),
  );
  ipc.handle("desktop:conversations:changes", (_event, after: string) =>
    apiFetch(
      `/conversations/changes?after=${encodeURIComponent(after)}`,
      undefined,
      { timeoutMs: 30000 },
    ),
  );
}

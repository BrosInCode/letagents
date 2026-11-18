import type { DesktopRoomPageDetail, DesktopRoomPageInfo } from "../../ipc-types.js";
import { apiFetch, readStoredAuth } from "../auth.js";
import { pageApiRequest, pageCallFailureFromApi, type PageApiRoute } from "./page-adapter.js";

/**
 * The page registry calls the app window makes for the person: read a page's
 * detail, make a page from an HTML attachment, grant and pin it, and roll an
 * update back. They go with the person's own app session (an `auth_sessions`
 * token, so the server's `isHumanAppWrite` holds), never with a page grant:
 * pin, approve and setCurrent are a room admin acting in person.
 */
export const PAGE_ADMIN_ROUTES = {
  "pages.get": { method: "GET", path: "/rooms/:room/pages/:pageId" },
  "pages.create": { method: "POST", path: "/rooms/:room/pages" },
  "pages.approve": { method: "POST", path: "/rooms/:room/pages/:pageId/approve" },
  "pages.pin": { method: "POST", path: "/rooms/:room/pages/:pageId/placements" },
  "pages.setCurrent": { method: "POST", path: "/rooms/:room/pages/:pageId/current" },
  "agents.list": { method: "GET", path: "/rooms/:room/agents" },
} as const satisfies Readonly<Record<string, PageApiRoute>>;

type AdminMethod = keyof typeof PAGE_ADMIN_ROUTES;
type FetchApi = typeof apiFetch;

const MESSAGE_ID = /^msg_\d+$/;
const ATTACHMENT_ID = /^att_\d+$/;

function cleanId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error(`The ${label} is missing.`);
  return value.trim();
}

export function createRoomPageAdmin(fetchApi: FetchApi = apiFetch, viewerAccountId: () => Promise<string | null> = async () => (await readStoredAuth()).account?.id ?? null) {
  async function send<T>(method: AdminMethod, roomId: unknown, input: Record<string, unknown>): Promise<T> {
    const request = pageApiRequest(PAGE_ADMIN_ROUTES[method], cleanId(roomId, "room"), input);
    try {
      return await fetchApi<T>(request.path, request.init, { credential: "app" });
    } catch (error) {
      // The renderer shows the message; the server's own words say what to do.
      throw new Error(pageCallFailureFromApi(error).message);
    }
  }

  /** Who made the live version, in words the room knows: an agent's name, "you", or "a room member". */
  async function updatedByLabel(roomId: unknown, detail: DesktopRoomPageDetail): Promise<string | null> {
    const author = detail.updatedBy;
    if (!author) return null;
    if (author.kind === "person") {
      return author.id === await viewerAccountId() ? "you" : "a room member";
    }
    try {
      const { agents } = await send<{ agents: Array<{ agentKey: string | null; label: string }> }>("agents.list", roomId, {});
      return agents.find((agent) => agent.agentKey === author.id)?.label ?? author.id;
    } catch {
      return author.id;
    }
  }

  return {
    async info(roomId: unknown, pageId: unknown): Promise<DesktopRoomPageInfo> {
      const detail = await send<DesktopRoomPageDetail>("pages.get", roomId, { pageId: cleanId(pageId, "page") });
      return { detail, updatedByLabel: await updatedByLabel(roomId, detail) };
    },
    /** A new page from an HTML attachment of a message in this room; its bytes are copied now. */
    async createFromAttachment(roomId: unknown, messageId: unknown, attachmentId: unknown): Promise<DesktopRoomPageDetail> {
      if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId)) throw new Error("Only a message in this room can become a page.");
      if (typeof attachmentId !== "string" || !ATTACHMENT_ID.test(attachmentId)) throw new Error("Only an uploaded HTML attachment can become a page.");
      return send("pages.create", roomId, { source: { messageId, attachmentId } });
    },
    async approve(roomId: unknown, pageId: unknown, version: unknown, capabilities: unknown): Promise<DesktopRoomPageDetail> {
      if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new Error("Choose a version to approve.");
      if (!Array.isArray(capabilities) || !capabilities.every((name) => typeof name === "string")) throw new Error("Choose what the page may do.");
      return send("pages.approve", roomId, { pageId: cleanId(pageId, "page"), version, capabilities: [...new Set(capabilities)] });
    },
    async pin(roomId: unknown, pageId: unknown): Promise<DesktopRoomPageDetail> {
      return send("pages.pin", roomId, { pageId: cleanId(pageId, "page"), surface: "room.tab" });
    },
    async setCurrent(roomId: unknown, pageId: unknown, version: unknown): Promise<DesktopRoomPageDetail> {
      if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new Error("Choose a version.");
      return send("pages.setCurrent", roomId, { pageId: cleanId(pageId, "page"), version });
    },
  };
}

export type RoomPageAdmin = ReturnType<typeof createRoomPageAdmin>;

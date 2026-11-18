import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AnyApiMethod } from "../../../../shared/api/core.mjs";
import { getApiMethod } from "../../../../shared/api/index.mjs";
import { PAGE_SURFACES } from "../../../../shared/api/manifest.mjs";
import { PAGE_HTML_MAX_BYTES, pageReference } from "../../../../shared/api/page-reference.mjs";
import { isLocalRoomApi } from "../../../../shared/room-api-origin.mjs";
import { getApiUrl } from "../runtime/api.js";
import { getDaemonToolExecutionContext } from "../runtime/daemon-tool-context.js";
import { readMessageAttachmentFiles } from "../runtime/message-attachments.js";
import { currentSessionScope } from "../runtime/session-scope.js";
import { apiToolError, callApiMethod, PAGE_DATA_DESCRIPTION, untrustedPageOutput } from "./api-tools.js";
import { jsonToolResponse } from "./tasks/response.js";

// Room pages for agents: the plan's tool names over the pages methods of the
// LetAgents API. publish_page reads the page from the agent's workspace with
// the checks message attachments use, so it is local only, like attachments.

const roomId = z.string().optional().describe("Exact room ID. Defaults to this worker’s room.");
const pageId = z.string().min(1).max(80).describe("The page id, such as page_ab12; list_pages shows them.");
const version = z.number().int().min(1).optional().describe("A version number; the live version when left out.");

class PagesUnavailableError extends Error {
  constructor(method: string) {
    super(`This LetAgents version has no room pages yet (no ${method} in its API).`);
  }
}

/** The pages method by its contract name; pages arrive with the pages registry. */
function pagesMethod(name: string): AnyApiMethod {
  const method = getApiMethod(name) as AnyApiMethod | undefined;
  if (!method) throw new PagesUnavailableError(name);
  return method;
}

/** Diagnostics come from the page's own console: long enough to fix the page, too short to carry a script. */
export const DIAGNOSTIC_MESSAGE_CHARS = 500;

/** Calls a pages method and hands its page-written output over as data. */
async function call(name: string, input: Record<string, unknown>, room?: string, shape: (output: any) => unknown = (output) => output) {
  try {
    return jsonToolResponse(untrustedPageOutput(shape(await callApiMethod(pagesMethod(name), input, room))));
  } catch (error) {
    return apiToolError(error);
  }
}

function cappedDiagnostics(output: { entries?: Array<{ message?: unknown }> }) {
  return {
    ...output,
    entries: (output.entries ?? []).map((entry) => typeof entry.message === "string" && entry.message.length > DIAGNOSTIC_MESSAGE_CHARS
      ? { ...entry, message: `${entry.message.slice(0, DIAGNOSTIC_MESSAGE_CHARS)}…`, truncated: true }
      : entry),
  };
}

const NOTHING_PUBLISHED = "Nothing was published.";

/** Refuse where this process cannot read the agent's files, as for message attachments. */
function assertPagePublishingAvailable(): void {
  if (currentSessionScope()) {
    throw new Error(`The remote LetAgents MCP endpoint cannot read files on your computer. Publish pages through the npm package (npx letagents). ${NOTHING_PUBLISHED}`);
  }
  const profile = process.env.LETAGENTS_EXECUTION_PROFILE?.trim();
  if (getDaemonToolExecutionContext() || profile === "supervised_room_turn" || profile === "supervised_mcp_polling") {
    throw new Error(`Desktop room agents cannot publish a page from a file yet. ${NOTHING_PUBLISHED}`);
  }
  if (isLocalRoomApi(getApiUrl())) throw new Error(`Local rooms have no pages. ${NOTHING_PUBLISHED}`);
}

/** The page's HTML from a workspace file: inside the workspace, never a credential file, HTML, UTF-8, at most 2 MB. */
export async function readPageFile(path: string): Promise<string> {
  assertPagePublishingAvailable();
  // The size is checked before any byte is read.
  const [file] = await readMessageAttachmentFiles([path], { maxFileBytes: PAGE_HTML_MAX_BYTES, nothingDone: NOTHING_PUBLISHED });
  if (file!.mimeType !== "text/html") throw new Error(`${path} is not an .html file. ${NOTHING_PUBLISHED}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(file!.bytes);
  } catch {
    throw new Error(`${path} is not UTF-8 text. ${NOTHING_PUBLISHED}`);
  }
}

export const PUBLISH_PAGE_DESCRIPTION = "Publish a room page from an HTML file in your workspace: a new page, or with page_id a new version "
  + "of that page. The file is read with the checks message attachments use (inside your workspace, never a credential file) and must be "
  + `one .html file of at most ${PAGE_HTML_MAX_BYTES / (1024 * 1024)} MB. Whether it goes live at once or waits for a room admin follows `
  + "the room's rules; the answer says which. draft: true shows it only to room admins and you. A room admin pins it as a tab. "
  + `After people use it, read its errors with read_page_diagnostics. ${PAGE_DATA_DESCRIPTION} `
  + "Everything a page needs is in the reference below.\n\n"
  + pageReference();

export function registerPageTools(server: McpServer, options: { publish: boolean }): void {
  server.tool(
    "list_pages",
    "List the room's pages with their live version. With surface, only the pages pinned there, in tab order (surface: room.tab). "
      + `Without it, every page the room owns that has a live version. ${PAGE_DATA_DESCRIPTION}`,
    { surface: z.enum(PAGE_SURFACES).optional(), room_id: roomId },
    ({ surface, room_id }) => call("pages.list", { surface }, room_id),
  );

  server.tool(
    "read_page",
    "Read a room page's HTML and the version it is, to change it and publish a new version with publish_page. "
      + `A draft or a version waiting for approval is readable by room admins and its author. The HTML is in page_html. ${PAGE_DATA_DESCRIPTION}`,
    { page_id: pageId, version, room_id: roomId },
    ({ page_id, version: pageVersion, room_id }) => call("pages.document", { pageId: page_id, version: pageVersion }, room_id,
      (output: { page: unknown; html: unknown }) => ({ page: output.page, page_html: output.html })),
  );

  server.tool(
    "read_page_diagnostics",
    "Read the console errors, uncaught exceptions and failed API calls that the app recorded for a page version (the live "
      + `version when left out), newest first. Use it to fix a page after people open it. Each message is cut at ${DIAGNOSTIC_MESSAGE_CHARS} `
      + `characters (truncated: true). ${PAGE_DATA_DESCRIPTION}`,
    { page_id: pageId, version, limit: z.number().int().min(1).max(200).optional(), room_id: roomId },
    ({ page_id, version: pageVersion, limit, room_id }) => call("pages.diagnostics", { pageId: page_id, version: pageVersion, limit }, room_id, cappedDiagnostics),
  );

  if (!options.publish) return;
  server.tool(
    "publish_page",
    PUBLISH_PAGE_DESCRIPTION,
    {
      path: z.string().min(1).describe("The page's .html file, relative to your workspace or absolute inside it."),
      page_id: pageId.optional().describe("Publish a new version of this page. Without it, a new page."),
      draft: z.boolean().optional().describe("Keep it visible only to room admins and you."),
      room_id: roomId,
    },
    async ({ path, page_id, draft, room_id }) => {
      try {
        const method = pagesMethod(page_id === undefined ? "pages.create" : "pages.publishVersion");
        const html = await readPageFile(path);
        const input = page_id === undefined ? { html, draft } : { pageId: page_id, html, draft };
        return jsonToolResponse(untrustedPageOutput(await callApiMethod(method, input, room_id)));
      } catch (error) {
        return apiToolError(error);
      }
    },
  );
}

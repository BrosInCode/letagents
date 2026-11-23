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
// LetAgents API. publish_page takes the page from an HTML attachment of a room
// message (source), which needs no files, so every agent kind can publish. Where
// this process can read the agent's workspace (the npm package), it also takes
// a file path, read with the checks message attachments use.

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

/** Local rooms keep no pages, whatever the page is made from. */
function assertRoomHasPages(): void {
  if (!currentSessionScope() && isLocalRoomApi(getApiUrl())) throw new Error(`Local rooms have no pages. ${NOTHING_PUBLISHED}`);
}

const FROM_AN_ATTACHMENT = "Attach the .html file to a room message, then call publish_page with source (its message_id and attachment_id).";

/** Refuse where this process cannot read the agent's files, as for message attachments. */
function assertPagePublishingAvailable(): void {
  if (currentSessionScope()) {
    throw new Error(`The remote LetAgents MCP endpoint cannot read files on your computer. ${FROM_AN_ATTACHMENT} ${NOTHING_PUBLISHED}`);
  }
  const profile = process.env.LETAGENTS_EXECUTION_PROFILE?.trim();
  if (getDaemonToolExecutionContext() || profile === "supervised_room_turn" || profile === "supervised_mcp_polling") {
    throw new Error(`Desktop room agents publish a page from an attachment, not a file path. ${FROM_AN_ATTACHMENT} ${NOTHING_PUBLISHED}`);
  }
  assertRoomHasPages();
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

/** read_page hands the HTML over in parts: a page may be 2 MB, far more than an agent should read at once. */
export const READ_PAGE_MAX_CHARS = 100_000;

/** One part of a page's HTML from `offset`, never splitting a character that takes two UTF-16 units. */
export function pageHtmlPart(html: string, offset = 0): { page_html: string; offset: number; total_chars: number; next_offset: number | null } {
  const start = Math.min(offset, html.length);
  let end = Math.min(start + READ_PAGE_MAX_CHARS, html.length);
  if (end < html.length && end > start && /[\uD800-\uDBFF]/.test(html[end - 1]!)) end -= 1;
  return { page_html: html.slice(start, end), offset: start, total_chars: html.length, next_offset: end < html.length ? end : null };
}

// The reference is about 17 KB. In publish_page's description it was sent on
// every turn; get_page_reference sends it when an agent writes a page.
const PAGE_RULES = "Call get_page_reference before you write or change a page: it has the manifest, the window.letagents API, "
  + `the capabilities and every method a page can call. The page is one self-contained .html file of at most ${PAGE_HTML_MAX_BYTES / (1024 * 1024)} MB `
  + "with a manifest script, inline CSS and JavaScript, no network.";
const PAGE_OUTCOME = "Whether it goes live at once or waits for a room admin follows the room's rules; the answer says "
  + "which. draft: true shows it only to room admins and you. A room admin pins it as a tab. "
  + `After people use it, read its errors with read_page_diagnostics. ${PAGE_DATA_DESCRIPTION}`;

/** For agents that can read their workspace: a file path, or an attachment. */
export const PUBLISH_PAGE_DESCRIPTION = "Publish a room page: a new page, or with page_id a new version of that page. "
  + "Give the HTML as path (a file in your workspace, read with the checks message attachments use: inside your workspace, "
  + "never a credential file) or as source (an .html attachment of a message in this room), not both. "
  + `${PAGE_RULES} ${PAGE_OUTCOME}`;

/** For agents whose tools cannot read their files (desktop room agents, remote bots): an attachment only. */
export const PUBLISH_PAGE_FROM_ATTACHMENT_DESCRIPTION = "Publish a room page from an .html attachment of a message in this room "
  + "(source: its message_id and attachment_id): a new page, or with page_id a new version of that page. Attach the file to a "
  + "message first; desktop room agents attach it to their reply with set_reply_attachments, and publish once that reply is posted. "
  + `${PAGE_RULES} ${PAGE_OUTCOME}`;

export const GET_PAGE_REFERENCE_DESCRIPTION = "The room page reference, as Markdown: the rules, the manifest, window.letagents, "
  + "the capabilities and every API method a page can call with its input and output. Read it before you write or change a page "
  + "for publish_page. Reads only.";

/**
 * Where publish_page may take the page from: "file" adds a workspace path
 * (only where this process can read the agent's files), "attachment" is a
 * message attachment only, null leaves publishing out.
 */
export type PagePublishing = "file" | "attachment" | null;

const pageSource = z.object({
  message_id: z.string().regex(/^msg_\d+$/).describe("The message that holds the attachment, such as msg_12."),
  attachment_id: z.string().regex(/^att_\d+$/).describe("The .html attachment of that message, such as att_1."),
}).strict();

export function registerPageTools(server: McpServer, options: { publish: PagePublishing }): void {
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
      + "A draft or a version waiting for approval is readable by room admins and its author. The HTML is in page_html, "
      + `at most ${READ_PAGE_MAX_CHARS.toLocaleString("en-US")} characters per call from offset (default 0); total_chars is its full length, and `
      + `next_offset, when not null, is the offset of the next part. ${PAGE_DATA_DESCRIPTION}`,
    {
      page_id: pageId,
      version,
      offset: z.number().int().min(0).optional().describe("The first character of page_html to return; next_offset from the previous part."),
      room_id: roomId,
    },
    ({ page_id, version: pageVersion, offset, room_id }) => call("pages.document", { pageId: page_id, version: pageVersion }, room_id,
      (output: { page: unknown; html: string }) => ({ page: output.page, ...pageHtmlPart(output.html, offset) })),
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
  // Only an agent that can publish needs the reference.
  server.tool("get_page_reference", GET_PAGE_REFERENCE_DESCRIPTION, {}, () => ({
    content: [{ type: "text" as const, text: pageReference() }],
  }));

  const fromFile = options.publish === "file";
  const common = {
    page_id: pageId.optional().describe("Publish a new version of this page. Without it, a new page."),
    draft: z.boolean().optional().describe("Keep it visible only to room admins and you."),
    room_id: roomId,
  };
  server.tool(
    "publish_page",
    fromFile ? PUBLISH_PAGE_DESCRIPTION : PUBLISH_PAGE_FROM_ATTACHMENT_DESCRIPTION,
    fromFile
      ? {
        path: z.string().min(1).optional().describe("The page's .html file, relative to your workspace or absolute inside it."),
        source: pageSource.optional().describe("An .html attachment of a message in this room, instead of path."),
        ...common,
      }
      : { source: pageSource.describe("The .html attachment of a message in this room that holds the page."), ...common },
    async ({ path, source, page_id, draft, room_id }: {
      path?: string; source?: z.infer<typeof pageSource>; page_id?: string; draft?: boolean; room_id?: string;
    }) => {
      try {
        if ((path === undefined) === (source === undefined)) {
          throw new Error(`Give the page as path or as source: one of them, not both. ${NOTHING_PUBLISHED}`);
        }
        const method = pagesMethod(page_id === undefined ? "pages.create" : "pages.publishVersion");
        let body: Record<string, unknown>;
        if (source) {
          assertRoomHasPages();
          body = { source: { messageId: source.message_id, attachmentId: source.attachment_id } };
        } else {
          body = { html: await readPageFile(path!) };
        }
        const input = page_id === undefined ? { ...body, draft } : { pageId: page_id, ...body, draft };
        return jsonToolResponse(untrustedPageOutput(await callApiMethod(method, input, room_id)));
      } catch (error) {
        return apiToolError(error);
      }
    },
  );
}

// Pages: room pages, their versions, placements and grants.
// A page is an HTML tool a team pins in its room. Its HTML is copied into page
// storage when it is made, so deleting the chat message keeps the page. Every
// route finds the page through the room in the URL: the room owns it or it is
// pinned there. Another room's page id is `not_found`.
import { z } from "zod";

import { GRANTABLE_CAPABILITY_NAMES } from "./capabilities.mjs";
import { defineMethod, queryInt } from "./core.mjs";
import { PAGE_MANIFEST_SCRIPT_TYPE, PAGE_OWNER_KINDS, PAGE_SURFACES } from "./manifest.mjs";

export const PAGE_LIMITS = Object.freeze({
  /** The page's HTML, as UTF-8 bytes. */
  htmlBytes: 2 * 1024 * 1024,
  /** Pages with a live version a room owns, pinned or not. */
  livePagesPerRoom: 50,
  /** Pages with no live version yet that one author made in one room. */
  unlivedPagesPerAuthor: 5,
  /** Drafts and versions waiting for approval per page. */
  unpublishedVersionsPerPage: 10,
  /** Drafts and versions waiting for approval per page per author; a new one replaces the author's oldest. */
  unpublishedVersionsPerAuthor: 3,
  /** Pinned pages per surface in one room. The desktop shows 3 as tabs and the rest in a menu. */
  placementsPerSurface: 10,
  /** Superseded versions kept per page for roll back; older ones are deleted. */
  supersededVersionsKept: 50,
  /** Diagnostics kept per page version; older entries are dropped. */
  diagnosticsPerVersion: 200,
  diagnosticsPerReport: 50,
  diagnosticMessageChars: 2000,
});

/**
 * - `live`: was the page's current version at some time, or is now.
 * - `draft`: only room admins and its author (or the author's owner) see it.
 * - `pending_approval`: waits for a room admin (pages.approve).
 * - `superseded`: a live version that a newer one replaced; pages.setCurrent can bring it back.
 */
export const PAGE_VERSION_STATUSES = /** @type {const} */ (["live", "draft", "pending_approval", "superseded"]);

export const PAGE_DIAGNOSTIC_KINDS = /** @type {const} */ (["console_error", "exception", "failed_call"]);

/** v1 pins pages on the room tab only; the other surfaces come later. */
export const PAGE_PIN_SURFACES = /** @type {const} */ (["room.tab"]);

const PAGE_ID = /^page_[A-Za-z0-9]{1,64}$/;
const PAGE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const pageId = z.string().regex(PAGE_ID, { error: "A page id looks like page_ followed by letters and digits." });
const pageVersion = z.number().int().positive();

/** What the room tab and a page's document name: the page and the version shown. */
export const PageRef = z.object({
  id: z.string(),
  title: z.string(),
  version: z.number().int().positive(),
});

/** An HTML attachment of a message in this room. Its bytes are copied when the page or version is made. */
export const PageSource = z.strictObject({
  messageId: z.string().regex(/^msg_\d+$/, { error: "A message id looks like msg_12." }),
  attachmentId: z.string().regex(/^att_\d+$/, { error: "An attachment id looks like att_1." }),
});

export const PageAuthor = z.object({
  kind: z.enum(["person", "agent"]),
  /** The account id of a person, the agent key of an agent. */
  id: z.string(),
  /** The account that owns the agent; null for a person. */
  ownerAccountId: z.string().nullable(),
});

export const PageVersionSummary = z.object({
  version: pageVersion,
  status: z.enum(PAGE_VERSION_STATUSES),
  sha256: z.string(),
  byteSize: z.number().int().positive(),
  author: PageAuthor,
  source: PageSource.nullable(),
  /** The capabilities the version's manifest asks for. */
  capabilities: z.array(z.string()),
  surfaces: z.array(z.string()),
  createdAt: z.string(),
});

export const PagePlacement = z.object({
  surface: z.enum(PAGE_SURFACES),
  /** 0 first. */
  position: z.number().int().nonnegative(),
  pinnedBy: z.string().nullable(),
  createdAt: z.string(),
});

/** What a room admin granted one version in this room. A page grant carries exactly these. */
export const PageGrantRecord = z.object({
  version: pageVersion,
  capabilities: z.array(z.string()),
  approvedBy: z.string().nullable(),
  approvedAt: z.string(),
});

export const PageManifestSummary = z.object({
  capabilities: z.array(z.string()),
  surfaces: z.array(z.string()),
  collections: z.object({
    viewer: z.array(z.string()).optional(),
    page: z.array(z.string()).optional(),
    room: z.array(z.string()).optional(),
  }),
  workItemFields: z.array(z.string()),
});

export const PageDetail = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  owner: z.object({ kind: z.enum(PAGE_OWNER_KINDS), id: z.string() }),
  /** The version the room sees; null until a version goes live. */
  currentVersion: pageVersion.nullable(),
  /** Who made the current version, for the "Updated by" banner. */
  updatedBy: PageAuthor.nullable(),
  placements: z.array(PagePlacement),
  /** The grant of the current version in this room; null when none was recorded. */
  grant: PageGrantRecord.nullable(),
  /** The current version's manifest; null when no version is live. */
  manifest: PageManifestSummary.nullable(),
  /** Newest first. Drafts and versions waiting for approval show only to room admins and their author. */
  versions: z.array(PageVersionSummary),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const PageList = z.object({ pages: z.array(PageRef) });
export const PageDocument = z.object({ page: PageRef, html: z.string() });

export const PageGrantToken = z.object({
  /** The page_grant bearer. Only the app's main process holds it; never hand it to the page. */
  token: z.string(),
  /** ISO time; open the page again (pages.grant) before then. */
  expiresAt: z.string(),
  /** What the live version was granted in this room; the bearer holds exactly these. */
  capabilities: z.array(z.string()),
});

export const PageDiagnosticEntry = z.object({
  kind: z.enum(PAGE_DIAGNOSTIC_KINDS),
  message: z.string(),
  at: z.string(),
});

export const PageDiagnostics = z.object({
  entries: z.array(PageDiagnosticEntry.extend({ version: pageVersion })),
});

/** @typedef {z.infer<typeof PageRef>} PageRef */
/** @typedef {z.infer<typeof PageSource>} PageSource */
/** @typedef {z.infer<typeof PageAuthor>} PageAuthor */
/** @typedef {z.infer<typeof PageVersionSummary>} PageVersionSummary */
/** @typedef {z.infer<typeof PagePlacement>} PagePlacement */
/** @typedef {z.infer<typeof PageGrantRecord>} PageGrantRecord */
/** @typedef {z.infer<typeof PageManifestSummary>} PageManifestSummary */
/** @typedef {z.infer<typeof PageDetail>} PageDetail */
/** @typedef {z.infer<typeof PageList>} PageList */
/** @typedef {z.infer<typeof PageDocument>} PageDocument */
/** @typedef {z.infer<typeof PageGrantToken>} PageGrantToken */
/** @typedef {z.infer<typeof PageDiagnosticEntry>} PageDiagnosticEntry */
/** @typedef {z.infer<typeof PageDiagnostics>} PageDiagnostics */
/** @typedef {typeof PAGE_VERSION_STATUSES[number]} PageVersionStatus */
/** @typedef {typeof PAGE_DIAGNOSTIC_KINDS[number]} PageDiagnosticKind */

/** @param {{ html?: unknown, source?: unknown }} value */
const oneHtmlSource = (value) => (value.html === undefined) !== (value.source === undefined);
const ONE_HTML_SOURCE = { error: "Send the page as html or as source (an HTML attachment), not both." };

const htmlInput = z.string().min(1, { error: "The HTML is empty." });

const MANIFEST_SCRIPT = new RegExp(
  `<script\\b[^>]*\\btype\\s*=\\s*["']?${PAGE_MANIFEST_SCRIPT_TYPE.replace(/[+.]/g, "\\$&")}["']?[^>]*>([\\s\\S]*?)</script\\s*>`,
  "gi",
);

/**
 * The manifest JSON text from a page's HTML: the one
 * `<script type="application/letagents-page+json">` element.
 * @param {string} html
 * @returns {{ ok: true, json: string } | { ok: false, message: string }}
 */
export function extractPageManifest(html) {
  const found = [...html.matchAll(MANIFEST_SCRIPT)];
  if (found.length === 0) {
    return { ok: false, message: `The page has no manifest. Add <script type="${PAGE_MANIFEST_SCRIPT_TYPE}"> with its JSON.` };
  }
  if (found.length > 1) return { ok: false, message: "The page has more than one manifest script; keep one." };
  return { ok: true, json: found[0][1] };
}

export const listPages = defineMethod({
  name: "pages.list",
  area: "pages",
  kind: "read",
  capability: "rooms.read",
  description:
    "The room's pages with their live version. With surface, only the pages pinned on that surface, in pin order (the room tab: surface=room.tab). Without it, every page the room owns that has a live version. Drafts and versions waiting for approval are never listed.",
  path: "/rooms/:room/pages",
  input: z.strictObject({ surface: z.enum(PAGE_SURFACES).optional() }),
  output: PageList,
  rateClass: "read",
  agents: "read",
});

export const getPageDocument = defineMethod({
  name: "pages.document",
  area: "pages",
  kind: "read",
  capability: "rooms.read",
  description:
    "A page's HTML (at most 2 MB) and the version it is. Without version, the live version. A draft or a version waiting for approval is readable only by room admins and its author (or the author's owner).",
  path: "/rooms/:room/pages/:pageId/document",
  input: z.strictObject({ pageId, version: queryInt({ min: 1, max: 1_000_000 }).optional() }),
  output: PageDocument,
  errors: ["not_found"],
  rateClass: "read",
  agents: "read",
});

export const getPage = defineMethod({
  name: "pages.get",
  area: "pages",
  kind: "read",
  capability: "rooms.read",
  description:
    "One page: title, live version, who made it (\"Updated by\"), where it is pinned, the capabilities granted to the live version, its manifest, and its versions newest first.",
  path: "/rooms/:room/pages/:pageId",
  input: z.strictObject({ pageId }),
  output: PageDetail,
  errors: ["not_found"],
  rateClass: "read",
  agents: "read",
});

export const createPage = defineMethod({
  name: "pages.create",
  area: "pages",
  kind: "write",
  capability: "rooms.read",
  description:
    "Makes a page in this room from its HTML (html) or from an HTML attachment of a message in this room (source). The HTML must hold one <script type=\"application/letagents-page+json\"> manifest; its title names the page. Version 1 goes live at once when a room admin or an agent in the room makes it and its manifest asks for no capabilities; otherwise it waits for a room admin to grant them (pages.approve). A person who is not a room admin always gets a version that waits. draft: true keeps it visible only to room admins and you. Until a version goes live, others see the page as \"Untitled\". A room holds 50 live pages, and each author at most 5 pages that are not live yet (conflict). Pinning is pages.pin.",
  path: "/rooms/:room/pages",
  input: z
    .strictObject({
      html: htmlInput.optional(),
      source: PageSource.optional(),
      /** Lower case letters, digits and dashes; made from the title when left out. */
      slug: z.string().regex(PAGE_SLUG, { error: "A slug is lower case letters, digits and dashes." }).optional(),
      draft: z.boolean().default(false),
    })
    .refine(oneHtmlSource, ONE_HTML_SOURCE),
  output: PageDetail,
  errors: ["not_found", "too_large", "conflict"],
  rateClass: "write",
  agents: "write",
});

export const publishPageVersion = defineMethod({
  name: "pages.publishVersion",
  area: "pages",
  kind: "write",
  capability: "rooms.read",
  description:
    "Adds a version of a page, from html or an HTML attachment (source). It goes live at once, with an \"Updated by\" record, when a room admin or an agent in the room made it and it asks for no capability beyond what the live version was granted. It waits for a room admin (status pending_approval) when it asks for more, or when the page holds jobs.start, messages.post or a *.propose capability and the author is a person who is not a room admin, or an agent whose owner is not one. draft: true keeps it visible only to room admins and its author. A page holds at most 10 drafts and waiting versions (conflict), and each author at most 3: a fourth replaces that author's oldest.",
  path: "/rooms/:room/pages/:pageId/versions",
  input: z
    .strictObject({ pageId, html: htmlInput.optional(), source: PageSource.optional(), draft: z.boolean().default(false) })
    .refine(oneHtmlSource, ONE_HTML_SOURCE),
  output: PageDetail,
  errors: ["not_found", "too_large", "conflict"],
  rateClass: "write",
  agents: "write",
});

export const pinPage = defineMethod({
  name: "pages.pin",
  area: "pages",
  kind: "write",
  capability: "rooms.admin",
  description:
    "Pins a page with a live version on a surface of this room (v1: room.tab), at position (0 first; the end when left out). Pinning it again moves it. Room admins only, signed in to the LetAgents app.",
  path: "/rooms/:room/pages/:pageId/placements",
  input: z.strictObject({
    pageId,
    surface: z.enum(PAGE_PIN_SURFACES).default("room.tab"),
    position: z.number().int().min(0).max(PAGE_LIMITS.placementsPerSurface - 1).optional(),
  }),
  output: PageDetail,
  errors: ["not_found", "conflict"],
  rateClass: "write",
});

export const unpinPage = defineMethod({
  name: "pages.unpin",
  area: "pages",
  kind: "write",
  httpMethod: "DELETE",
  capability: "rooms.admin",
  description:
    "Removes a page from a surface of this room and ends every open page grant for it. The page and its versions stay. Room admins only, signed in to the LetAgents app.",
  path: "/rooms/:room/pages/:pageId/placements",
  input: z.strictObject({ pageId, surface: z.enum(PAGE_SURFACES).default("room.tab") }),
  output: PageDetail,
  errors: ["not_found"],
  rateClass: "write",
});

export const approvePageVersion = defineMethod({
  name: "pages.approve",
  area: "pages",
  kind: "write",
  capability: "rooms.admin",
  description:
    "Grants a version the capabilities a room admin chose (each must be in its manifest; fewer is fine). A version waiting for approval then goes live. On the live version it changes the grant. Either way every open page grant for the page ends, so viewers open it again with the new grant. Room admins only, signed in to the LetAgents app.",
  path: "/rooms/:room/pages/:pageId/approve",
  input: z.strictObject({
    pageId,
    version: pageVersion,
    capabilities: z.array(z.enum(GRANTABLE_CAPABILITY_NAMES)).refine((names) => new Set(names).size === names.length, {
      error: "Capabilities must not repeat.",
    }),
  }),
  output: PageDetail,
  errors: ["not_found", "conflict"],
  rateClass: "write",
});

export const setCurrentPageVersion = defineMethod({
  name: "pages.setCurrent",
  area: "pages",
  kind: "write",
  capability: "rooms.admin",
  description:
    "Makes an earlier live version the page's live version again (roll back, or Undo after an update). It keeps the grant that version had. Every open page grant for the page ends. Room admins only, signed in to the LetAgents app.",
  path: "/rooms/:room/pages/:pageId/current",
  input: z.strictObject({ pageId, version: pageVersion }),
  output: PageDetail,
  errors: ["not_found", "conflict"],
  rateClass: "write",
});

export const deletePage = defineMethod({
  name: "pages.delete",
  area: "pages",
  kind: "write",
  httpMethod: "DELETE",
  capability: "rooms.admin",
  description:
    "Deletes a page this room owns, with every version, placement, grant and diagnostic, and ends its open page grants. Room admins only, signed in to the LetAgents app.",
  path: "/rooms/:room/pages/:pageId",
  input: z.strictObject({ pageId }),
  output: z.object({ id: z.string(), deleted: z.literal(true) }),
  errors: ["not_found"],
  rateClass: "write",
});

export const grantPage = defineMethod({
  name: "pages.grant",
  area: "pages",
  kind: "write",
  capability: "rooms.read",
  description:
    "Opens a pinned page for the signed-in person: a short-lived page_grant for the live version, with the capabilities a room admin granted it. The LetAgents app calls this in its main process and keeps the token from the page. People only, signed in to the app; agents and pages get not_granted. conflict: the page changed while it was opening; call again.",
  path: "/rooms/:room/pages/:pageId/grant",
  input: z.strictObject({ pageId }),
  output: PageGrantToken,
  errors: ["not_found", "conflict"],
  rateClass: "write",
});

export const reportPageDiagnostics = defineMethod({
  name: "pages.reportDiagnostics",
  area: "pages",
  kind: "write",
  capability: "rooms.read",
  description:
    "Records console errors, uncaught exceptions and failed calls of a page version, for its authors to read. The newest 200 per version are kept. Sent by the LetAgents app showing the page, with the person's app session, or by the page version itself through its page grant.",
  path: "/rooms/:room/pages/:pageId/diagnostics",
  input: z.strictObject({
    pageId,
    version: pageVersion,
    entries: z
      .array(z.strictObject({
        kind: z.enum(PAGE_DIAGNOSTIC_KINDS),
        message: z.string().min(1).max(PAGE_LIMITS.diagnosticMessageChars),
        /** When it happened; the server's time when left out. */
        at: z.iso.datetime({ offset: true }).optional(),
      }))
      .min(1)
      .max(PAGE_LIMITS.diagnosticsPerReport),
  }),
  output: z.object({ accepted: z.number().int().nonnegative() }),
  errors: ["not_found"],
  rateClass: "write",
});

export const listPageDiagnostics = defineMethod({
  name: "pages.diagnostics",
  area: "pages",
  kind: "read",
  capability: "rooms.read",
  description:
    "The newest console errors, exceptions and failed calls reported for a page version (the live version when left out), newest first. Readable by room admins, the version's author (or the author's owner) and agents in the room; a draft's or waiting version's only by those who can see it.",
  path: "/rooms/:room/pages/:pageId/diagnostics",
  input: z.strictObject({
    pageId,
    version: queryInt({ min: 1, max: 1_000_000 }).optional(),
    limit: queryInt({ min: 1, max: PAGE_LIMITS.diagnosticsPerVersion, default: 50 }),
  }),
  output: PageDiagnostics,
  errors: ["not_found"],
  rateClass: "read",
  agents: "read",
});

export const methods = /** @type {const} */ ([
  listPages,
  getPageDocument,
  getPage,
  createPage,
  publishPageVersion,
  pinPage,
  unpinPage,
  approvePageVersion,
  setCurrentPageVersion,
  deletePage,
  grantPage,
  reportPageDiagnostics,
  listPageDiagnostics,
]);

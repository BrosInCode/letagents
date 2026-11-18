// Data: shared JSON documents in the viewer, page and room scopes.
// - viewer: one person's own data for one page (settings, a tab choice).
// - page: shared by everyone using one page (a meeting's next steps).
// - room: shared by all pages and agents in the room (a release calendar).
// Each scope needs its own capability: data.viewer, data.page, data.room.
import { z } from "zod";

import { ACTOR_PRINCIPAL_KINDS } from "./actor.mjs";
import { defineMethod, queryInt } from "./core.mjs";
import { DATA_SCOPES } from "./manifest.mjs";

export { DATA_SCOPES };

/** A collection name; the manifest's `collections` lists use the same rule. */
export const DATA_COLLECTION_NAME = /^[a-z][a-z0-9_]{0,39}$/;
export const DATA_DOC_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
export const DATA_PAGE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export const DATA_LIMITS = Object.freeze({
  /** One document's JSON text, in bytes. */
  docBytes: 64 * 1024,
  /** Documents in one scope: one page, one viewer of one page, or the room. */
  docsPerScope: 5_000,
  /** All of one viewer's documents for one page, in bytes. */
  viewerBytesPerPage: 16 * 1024,
  /** All documents in one room, every scope together. */
  docsPerRoom: 50_000,
  /** All documents in one room, in bytes. */
  bytesPerRoom: 50 * 1024 * 1024,
  /** Objects and arrays inside one another, the document itself counted. */
  maxDepth: 64,
  listDefault: 50,
  listMax: 100,
  /** A list page stops early once its documents hold this many bytes. */
  listBytes: 1024 * 1024,
});

/** @typedef {typeof DATA_SCOPES[number]} DataScope */

/** The capability each scope needs. */
export const DATA_SCOPE_CAPABILITIES = Object.freeze(
  /** @type {const} */ ({ viewer: "data.viewer", page: "data.page", room: "data.room" }),
);

const scope = z.enum(DATA_SCOPES);
const collection = z.string().regex(DATA_COLLECTION_NAME, {
  error: "A collection name is lower case letters, digits and _, starting with a letter, at most 40 characters.",
});
const docId = z.string().regex(DATA_DOC_ID, {
  error: "A document id is 1 to 128 letters, digits, _, ., : or -.",
});
const pageId = z
  .string()
  .regex(DATA_PAGE_ID, { error: "A page id is 1 to 128 letters, digits, _, ., : or -." })
  .optional()
  .describe(
    "The page whose data this is, for the viewer and page scopes. A page leaves it out (its own id is used); a person or agent calling directly must give it. Not used in the room scope.",
  );
const ifRevision = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe("Compare-and-set: write only when the document's revision is this number (0: only when the document does not exist yet). Otherwise the call fails with conflict.");
const ifRevisionQuery = queryInt({ min: 0, max: 2_147_483_647 })
  .optional()
  .describe("Compare-and-set: delete only when the document's revision is this number. Otherwise the call fails with conflict.");

/** Keys that name an object's prototype machinery in JavaScript; a page or agent reading the data must never meet them. */
export const DATA_FORBIDDEN_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);

/**
 * The first reason a JSON value cannot be stored, or null. Postgres jsonb
 * refuses NUL and lone surrogates, so they are refused here as
 * invalid_input instead. The walk stops at maxDepth, so a deep value costs
 * no more than a shallow one.
 * @param {unknown} value
 * @returns {{ path: (string | number)[], message: string } | null}
 */
export function findDataProblem(value) {
  /** @type {(string | number)[]} */
  const path = [];
  /** @param {unknown} node @param {number} depth @returns {string | null} */
  const walk = (node, depth) => {
    if (typeof node === "string") return badText(node) ? `${badText(node)} in a string.` : null;
    if (node === null || typeof node !== "object") return null;
    if (depth > DATA_LIMITS.maxDepth) return `Objects and arrays nest at most ${DATA_LIMITS.maxDepth} deep.`;
    const entries = Array.isArray(node) ? node.entries() : Object.entries(node);
    for (const [key, child] of entries) {
      path.push(key);
      if (typeof key === "string") {
        if (DATA_FORBIDDEN_KEYS.includes(key)) return `The key "${key}" is not allowed.`;
        if (badText(key)) return `${badText(key)} in a key.`;
      }
      const problem = walk(child, depth + 1);
      if (problem) return problem;
      path.pop();
    }
    return null;
  };
  const message = walk(value, 1);
  return message ? { path, message } : null;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** @param {string} text @returns {string | null} */
function badText(text) {
  if (text.includes("\u0000")) return "A NUL character (\\u0000) is not allowed";
  if (LONE_SURROGATE.test(text)) return "A lone UTF-16 surrogate is not allowed";
  return null;
}

/**
 * A document body: a JSON object with no NUL, no lone surrogates, no
 * prototype keys and at most maxDepth levels. The check runs on the raw
 * value, before the record parse drops a "__proto__" key, so such a key is
 * refused, not quietly lost.
 */
const dataObject = /** @type {z.ZodType<Record<string, unknown>, Record<string, unknown>>} */ (
  z.preprocess((value, ctx) => {
    const problem = findDataProblem(value);
    if (problem) ctx.addIssue({ code: "custom", path: problem.path, message: problem.message, input: value });
    return value;
  }, z.record(z.string(), z.unknown()))
);

const json = z.record(z.string(), z.unknown());

export const DataDocument = z.object({
  scope,
  /** The page for the viewer and page scopes; null in the room scope. */
  pageId: z.string().nullable(),
  collection: z.string(),
  docId: z.string(),
  data: json,
  /** One more for each write, a delete included, so a revision never repeats for one doc id. */
  revision: z.number().int().positive(),
  /** The person (account id) or agent (agent key) that wrote it last. */
  updatedBy: z.object({ kind: z.enum(ACTOR_PRINCIPAL_KINDS), id: z.string() }),
  updatedAt: z.string(),
});

export const DataDocumentPage = z.object({
  documents: z.array(DataDocument),
  /** Pass as `after` for the next page; null when this is the last one. */
  nextAfter: z.string().nullable(),
});

/** @typedef {z.infer<typeof DataDocument>} DataDocument */
/** @typedef {z.infer<typeof DataDocumentPage>} DataDocumentPage */

const COLLECTION_PATH = "/rooms/:room/data/:scope/:collection";
const DOCUMENT_PATH = "/rooms/:room/data/:scope/:collection/:docId";

// Every data method needs the capability of the scope in its input
// (DATA_SCOPE_CAPABILITIES); data.page is the one the reference names.
/** @param {{ scope: DataScope }} input */
const scopeCapability = (input) => DATA_SCOPE_CAPABILITIES[input.scope];

export const listDocuments = defineMethod({
  name: "data.list",
  area: "data",
  kind: "read",
  capability: "data.page",
  capabilityFromInput: scopeCapability,
  description:
    "Documents in one collection, in doc id order, a page at a time. Scope is viewer (your own data for one page), page (shared by everyone using one page) or room (shared by all pages and agents in the room). Pass nextAfter as after for the next page.",
  path: COLLECTION_PATH,
  input: z.strictObject({
    scope,
    collection,
    pageId,
    after: docId.optional().describe("List documents whose id sorts after this one."),
    limit: queryInt({ min: 1, max: DATA_LIMITS.listMax, default: DATA_LIMITS.listDefault }),
  }),
  output: DataDocumentPage,
  rateClass: "read",
  agents: "read",
});

export const getDocument = defineMethod({
  name: "data.get",
  area: "data",
  kind: "read",
  capability: "data.page",
  capabilityFromInput: scopeCapability,
  description: "One document by collection and doc id, with its revision for a later compare-and-set write.",
  path: DOCUMENT_PATH,
  input: z.strictObject({ scope, collection, docId, pageId }),
  output: DataDocument,
  errors: ["not_found"],
  rateClass: "read",
  agents: "read",
});

export const setDocument = defineMethod({
  name: "data.set",
  area: "data",
  kind: "write",
  capability: "data.page",
  capabilityFromInput: scopeCapability,
  description:
    "Create or replace one document with a JSON object (at most 64 KB and 64 levels deep; no NUL characters and no __proto__, constructor or prototype keys). Caps: 5,000 documents per scope, 16 KB in all for one viewer of one page, 50,000 documents and 50 MB per room. Pass ifRevision to write only over the revision you read.",
  path: DOCUMENT_PATH,
  httpMethod: "PUT",
  input: z.strictObject({ scope, collection, docId, pageId, data: dataObject, ifRevision }),
  output: DataDocument,
  errors: ["conflict", "too_large"],
  rateClass: "write",
  agents: "write",
});

export const updateDocument = defineMethod({
  name: "data.update",
  area: "data",
  kind: "write",
  capability: "data.page",
  capabilityFromInput: scopeCapability,
  description:
    "Change some top-level fields of an existing document: each field in data replaces that field, and a field set to null is removed. Other fields stay. Pass ifRevision to change only the revision you read.",
  path: DOCUMENT_PATH,
  httpMethod: "PATCH",
  input: z.strictObject({ scope, collection, docId, pageId, data: dataObject, ifRevision }),
  output: DataDocument,
  errors: ["not_found", "conflict", "too_large"],
  rateClass: "write",
  agents: "write",
});

export const deleteDocument = defineMethod({
  name: "data.delete",
  area: "data",
  kind: "write",
  capability: "data.page",
  capabilityFromInput: scopeCapability,
  description: "Delete one document. deleted is false when there was no such document.",
  path: DOCUMENT_PATH,
  httpMethod: "DELETE",
  input: z.strictObject({ scope, collection, docId, pageId, ifRevision: ifRevisionQuery }),
  output: z.object({ deleted: z.boolean() }),
  errors: ["conflict"],
  rateClass: "write",
  agents: "write",
});

export const methods = /** @type {const} */ ([listDocuments, getDocument, setDocument, updateDocument, deleteDocument]);

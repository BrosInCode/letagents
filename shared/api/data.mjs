// Data: shared JSON documents in the viewer, page and room scopes.
// - viewer: one person's own data for one page (settings, a tab choice).
// - page: shared by everyone using one page (a meeting's next steps).
// - room: shared by all pages and agents in the room (a release calendar).
// Each scope needs its own capability: data.viewer, data.page, data.room.
import { z } from "zod";

import { ACTOR_PRINCIPAL_KINDS } from "./actor.mjs";
import { defineMethod } from "./core.mjs";
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
const ifRevisionQuery = z.coerce
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe("Compare-and-set: delete only when the document's revision is this number. Otherwise the call fails with conflict.");

const json = z.record(z.string(), z.unknown());

export const DataDocument = z.object({
  scope,
  /** The page for the viewer and page scopes; null in the room scope. */
  pageId: z.string().nullable(),
  collection: z.string(),
  docId: z.string(),
  data: json,
  /** 1 for a new document, then one more for each write. */
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

// Every data method names data.page as its capability; the handler also
// checks the capability of the scope in the input (DATA_SCOPE_CAPABILITIES).
// Once checkCapability receives the parsed input, the scope is decided there.

export const listDocuments = defineMethod({
  name: "data.list",
  area: "data",
  kind: "read",
  capability: "data.page",
  description:
    "Documents in one collection, in doc id order, a page at a time. Scope is viewer (your own data for one page), page (shared by everyone using one page) or room (shared by all pages and agents in the room). Pass nextAfter as after for the next page.",
  path: COLLECTION_PATH,
  input: z.strictObject({
    scope,
    collection,
    pageId,
    after: docId.optional().describe("List documents whose id sorts after this one."),
    limit: z.coerce.number().int().min(1).max(DATA_LIMITS.listMax).default(DATA_LIMITS.listDefault),
  }),
  output: DataDocumentPage,
  rateClass: "read",
});

export const getDocument = defineMethod({
  name: "data.get",
  area: "data",
  kind: "read",
  capability: "data.page",
  description: "One document by collection and doc id, with its revision for a later compare-and-set write.",
  path: DOCUMENT_PATH,
  input: z.strictObject({ scope, collection, docId, pageId }),
  output: DataDocument,
  errors: ["not_found"],
  rateClass: "read",
});

export const setDocument = defineMethod({
  name: "data.set",
  area: "data",
  kind: "write",
  capability: "data.page",
  description:
    "Create or replace one document with a JSON object (at most 64 KB; 5,000 documents per scope; 16 KB in all for one viewer of one page). Pass ifRevision to write only over the revision you read.",
  path: DOCUMENT_PATH,
  httpMethod: "PUT",
  input: z.strictObject({ scope, collection, docId, pageId, data: json, ifRevision }),
  output: DataDocument,
  errors: ["conflict", "too_large"],
  rateClass: "write",
});

export const updateDocument = defineMethod({
  name: "data.update",
  area: "data",
  kind: "write",
  capability: "data.page",
  description:
    "Change some top-level fields of an existing document: each field in data replaces that field, and a field set to null is removed. Other fields stay. Pass ifRevision to change only the revision you read.",
  path: DOCUMENT_PATH,
  httpMethod: "PATCH",
  input: z.strictObject({ scope, collection, docId, pageId, data: json, ifRevision }),
  output: DataDocument,
  errors: ["not_found", "conflict", "too_large"],
  rateClass: "write",
});

export const deleteDocument = defineMethod({
  name: "data.delete",
  area: "data",
  kind: "write",
  capability: "data.page",
  description: "Delete one document. deleted is false when there was no such document.",
  path: DOCUMENT_PATH,
  httpMethod: "DELETE",
  input: z.strictObject({ scope, collection, docId, pageId, ifRevision: ifRevisionQuery }),
  output: z.object({ deleted: z.boolean() }),
  errors: ["conflict"],
  rateClass: "write",
});

export const methods = /** @type {const} */ ([listDocuments, getDocument, setDocument, updateDocument, deleteDocument]);

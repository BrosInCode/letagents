import type { ApiActor } from "../../../shared/api/actor.mjs";
import { ApiError } from "../../../shared/api/core.mjs";
import type { DataDocument, DataDocumentPage, DataScope } from "../../../shared/api/data.mjs";
import type { PageManifest } from "../../../shared/api/manifest.mjs";
import { ROOM_RESOURCE_DOCUMENTS } from "../../../shared/room-resource-invalidation.mjs";
import {
  deleteApiDocument,
  getApiDocument,
  listApiDocuments,
  writeApiDocument,
  type ApiDocumentKey,
  type ApiDocumentRow,
  type ApiDocumentScope,
} from "../db/api-documents.js";
import { queueRoomResourceInvalidation } from "../server/events.js";

// The data.* methods for any transport: the /api/v1 routes call these, and
// so can MCP tools. The caller passes the actor and the room in the URL;
// every document key is built here from those two, never from a room or an
// account named in the input.

export interface DocumentCall {
  actor: ApiActor;
  /** The room in the URL, already checked for the actor. */
  roomId: string;
}

export interface DocumentDeps {
  invalidate?: (roomId: string) => void;
}

interface ScopeInput {
  scope: DataScope;
  pageId?: string;
}

interface DocumentInput extends ScopeInput {
  collection: string;
  docId: string;
}

export type ResolvedDocumentScope = ApiDocumentScope & { pageId: string | null };

const invalidateDocuments = (roomId: string) => queueRoomResourceInvalidation(roomId, ROOM_RESOURCE_DOCUMENTS);

/**
 * The scope id the actor may use:
 * - room: `''`; a page id makes no sense here and is refused.
 * - page: the page's own id when a page calls; otherwise `pageId` from the
 *   input, which a person or agent calling directly must give.
 * - viewer: `<page id>:<account id>` of the caller. It is only ever the
 *   caller's own account, so it needs a person.
 */
export function resolveDocumentScope(call: DocumentCall, input: ScopeInput): ResolvedDocumentScope {
  const { actor, roomId } = call;
  if (input.scope === "room") {
    if (input.pageId !== undefined) throw new ApiError("invalid_input", "pageId: the room scope belongs to no page; leave pageId out.");
    return { roomId, scope: "room", scopeId: "", pageId: null };
  }
  let pageId: string;
  if (actor.via?.kind === "page") {
    if (input.pageId !== undefined && input.pageId !== actor.via.id) {
      throw new ApiError("not_granted", "A page reads and writes only its own page data.");
    }
    pageId = actor.via.id;
  } else {
    if (input.pageId === undefined) throw new ApiError("invalid_input", `pageId: the ${input.scope} scope needs the page id.`);
    pageId = input.pageId;
  }
  if (input.scope === "page") return { roomId, scope: "page", scopeId: pageId, pageId };
  if (actor.principal.kind !== "person") {
    throw new ApiError("not_granted", "The viewer scope holds one person's own data; an agent has none.");
  }
  // Account ids hold no ":", so the last ":" always splits page from account.
  return { roomId, scope: "viewer", scopeId: `${pageId}:${actor.principal.id}`, pageId };
}

/**
 * The collections a page's manifest names, per scope, or null for no limit.
 * Only a page is limited, and only to its own manifest. Null for everyone
 * today: the pages registry (PR7) fills this from the granted page version.
 */
export async function allowedCollectionsFor(actor: ApiActor): Promise<PageManifest["collections"] | null> {
  if (actor.via?.kind !== "page") return null;
  return null;
}

async function checkCollection(actor: ApiActor, scope: DataScope, collection: string): Promise<void> {
  const allowed = await allowedCollectionsFor(actor);
  if (allowed && !allowed[scope]?.includes(collection)) {
    throw new ApiError("not_granted", `This page's manifest does not name the "${collection}" collection in the ${scope} scope.`);
  }
}

async function documentKey(call: DocumentCall, input: DocumentInput): Promise<{ key: ApiDocumentKey; pageId: string | null }> {
  const { pageId, ...scope } = resolveDocumentScope(call, input);
  await checkCollection(call.actor, input.scope, input.collection);
  return { key: { ...scope, collection: input.collection, docId: input.docId }, pageId };
}

export function toDataDocument(row: ApiDocumentRow, pageId: string | null): DataDocument {
  return {
    scope: row.scope,
    pageId,
    collection: row.collection,
    docId: row.doc_id,
    data: row.data,
    revision: row.revision,
    updatedBy: { kind: row.updated_by_kind, id: row.updated_by_id },
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listDocuments(
  call: DocumentCall,
  input: ScopeInput & { collection: string; after?: string; limit: number },
): Promise<DataDocumentPage> {
  const { pageId, ...scope } = resolveDocumentScope(call, input);
  await checkCollection(call.actor, input.scope, input.collection);
  const { rows, nextAfter } = await listApiDocuments({ ...scope, collection: input.collection, after: input.after, limit: input.limit });
  return { documents: rows.map((row) => toDataDocument(row, pageId)), nextAfter };
}

export async function getDocument(call: DocumentCall, input: DocumentInput): Promise<DataDocument> {
  const { key, pageId } = await documentKey(call, input);
  const row = await getApiDocument(key);
  if (!row) throw new ApiError("not_found", "No document with this id in this collection.");
  return toDataDocument(row, pageId);
}

export async function setDocument(
  call: DocumentCall,
  input: DocumentInput & { data: Record<string, unknown>; ifRevision?: number },
  deps: DocumentDeps = {},
): Promise<DataDocument> {
  const { key, pageId } = await documentKey(call, input);
  const row = await writeApiDocument(key, { mode: "set", data: input.data, ifRevision: input.ifRevision, writer: call.actor.principal });
  (deps.invalidate ?? invalidateDocuments)(call.roomId);
  return toDataDocument(row, pageId);
}

export async function updateDocument(
  call: DocumentCall,
  input: DocumentInput & { data: Record<string, unknown>; ifRevision?: number },
  deps: DocumentDeps = {},
): Promise<DataDocument> {
  const { key, pageId } = await documentKey(call, input);
  const row = await writeApiDocument(key, { mode: "update", data: input.data, ifRevision: input.ifRevision, writer: call.actor.principal });
  (deps.invalidate ?? invalidateDocuments)(call.roomId);
  return toDataDocument(row, pageId);
}

export async function deleteDocument(
  call: DocumentCall,
  input: DocumentInput & { ifRevision?: number },
  deps: DocumentDeps = {},
): Promise<{ deleted: boolean }> {
  const { key } = await documentKey(call, input);
  const deleted = await deleteApiDocument(key, { ifRevision: input.ifRevision });
  if (deleted) (deps.invalidate ?? invalidateDocuments)(call.roomId);
  return { deleted };
}

import {
  DATA_SCOPE_CAPABILITIES,
  deleteDocument,
  getDocument,
  listDocuments,
  setDocument,
  updateDocument,
  type DataScope,
} from "../../../../shared/api/data.mjs";
import { checkCapability } from "../capability.js";
import type { ApiCallContext } from "../context.js";
import * as documents from "../documents.js";
import { defineRoute, type ApiRoute } from "../route.js";

/**
 * Each scope has its own capability; the router checked only the method's
 * (data.page). Once checkCapability receives the parsed input (PR0b), the
 * scope's capability is decided there and this check goes.
 */
async function checkScope(scope: DataScope, call: ApiCallContext): Promise<documents.DocumentCall> {
  await checkCapability(call.actor, DATA_SCOPE_CAPABILITIES[scope], call);
  return { actor: call.actor, roomId: call.room.id };
}

// Routes for the methods in shared/api/data.mjs, made with defineRoute.
export const routes: readonly ApiRoute[] = [
  defineRoute(listDocuments, async (input, call) => documents.listDocuments(await checkScope(input.scope, call), input)),
  defineRoute(getDocument, async (input, call) => documents.getDocument(await checkScope(input.scope, call), input)),
  defineRoute(setDocument, async (input, call) => documents.setDocument(await checkScope(input.scope, call), input)),
  defineRoute(updateDocument, async (input, call) => documents.updateDocument(await checkScope(input.scope, call), input)),
  defineRoute(deleteDocument, async (input, call) => documents.deleteDocument(await checkScope(input.scope, call), input)),
];

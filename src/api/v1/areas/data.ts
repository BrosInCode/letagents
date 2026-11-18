import { deleteDocument, getDocument, listDocuments, setDocument, updateDocument } from "../../../../shared/api/data.mjs";
import type { ApiCallContext } from "../context.js";
import * as documents from "../documents.js";
import { defineRoute, type ApiRoute } from "../route.js";

// The pipeline already checked the scope's capability (capabilityFromInput).
const documentCall = (call: ApiCallContext): documents.DocumentCall => ({ actor: call.actor, room: call.room, account: call.account });

// Routes for the methods in shared/api/data.mjs, made with defineRoute.
export const routes: readonly ApiRoute[] = [
  defineRoute(listDocuments, (input, call) => documents.listDocuments(documentCall(call), input)),
  defineRoute(getDocument, (input, call) => documents.getDocument(documentCall(call), input)),
  defineRoute(setDocument, (input, call) => documents.setDocument(documentCall(call), input)),
  defineRoute(updateDocument, (input, call) => documents.updateDocument(documentCall(call), input)),
  defineRoute(deleteDocument, (input, call) => documents.deleteDocument(documentCall(call), input)),
];

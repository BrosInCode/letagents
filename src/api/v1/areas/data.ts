import { deleteDocument, getDocument, listDocuments, setDocument, updateDocument, type DataScope } from "../../../../shared/api/data.mjs";
import type { AnyApiMethod } from "../../../../shared/api/core.mjs";
import { checkCapability } from "../capability.js";
import type { ApiCallContext } from "../context.js";
import * as documents from "../documents.js";
import { defineRoute, type ApiRoute } from "../route.js";

/**
 * Each scope needs its own capability (the data methods' capabilityFromInput).
 * The router's check does not read capabilityFromInput yet, so the handler
 * asks again with the scope's capability. This goes once the router's
 * checkCapability uses capabilityFromInput (PR1).
 */
export async function checkScopeCapability(method: AnyApiMethod, input: { scope: DataScope }, call: ApiCallContext): Promise<documents.DocumentCall> {
  const capability = method.capabilityFromInput?.(input) ?? method.capability;
  await checkCapability(call.actor, { ...method, capability }, input, call);
  return { actor: call.actor, room: call.room, account: call.account };
}

// Routes for the methods in shared/api/data.mjs, made with defineRoute.
export const routes: readonly ApiRoute[] = [
  defineRoute(listDocuments, async (input, call) => documents.listDocuments(await checkScopeCapability(listDocuments, input, call), input)),
  defineRoute(getDocument, async (input, call) => documents.getDocument(await checkScopeCapability(getDocument, input, call), input)),
  defineRoute(setDocument, async (input, call) => documents.setDocument(await checkScopeCapability(setDocument, input, call), input)),
  defineRoute(updateDocument, async (input, call) => documents.updateDocument(await checkScopeCapability(updateDocument, input, call), input)),
  defineRoute(deleteDocument, async (input, call) => documents.deleteDocument(await checkScopeCapability(deleteDocument, input, call), input)),
];

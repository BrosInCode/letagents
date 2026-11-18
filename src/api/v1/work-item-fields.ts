import type { ApiActor } from "../../../shared/api/actor.mjs";
import { pageWorkItemFields } from "./pages.js";

/**
 * The Jira custom fields an actor may read raw through `work_items.*`
 * (`fields`), or null for any field. A person reading for themselves may
 * name any field of a ticket they can already see. A page gets the
 * manifest's `workItemFields` of the version its grant names; a job or an
 * agent gets none.
 */
export type WorkItemFieldAllowance = (actor: ApiActor) => Promise<readonly string[] | null>;

export const allowedWorkItemFields: WorkItemFieldAllowance = async (actor) => {
  if (actor.principal.kind === "person" && (!actor.via || actor.via.kind === "integration")) return null;
  if (actor.via?.kind === "page" && actor.via.version !== undefined) return pageWorkItemFields(actor.via.id, actor.via.version);
  return [];
};

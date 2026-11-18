import type { ApiActor } from "../../../shared/api/actor.mjs";

/**
 * The Jira custom fields an actor may read raw through `work_items.*`
 * (`fields`), or null for any field. A person reading for themselves may
 * name any field of a ticket they can already see. A page or a job gets
 * none until the pages registry (PR7) returns the manifest's
 * `workItemFields` for the page version here.
 */
export type WorkItemFieldAllowance = (actor: ApiActor) => readonly string[] | null;

export const allowedWorkItemFields: WorkItemFieldAllowance = (actor) =>
  actor.principal.kind === "person" && (!actor.via || actor.via.kind === "integration") ? null : [];

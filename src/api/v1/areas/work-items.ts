import type { ApiActor } from "../../../../shared/api/actor.mjs";
import { ApiError } from "../../../../shared/api/core.mjs";
import { getWorkItem, getWorkItemHistory, searchWorkItems } from "../../../../shared/api/work-items.mjs";
import { getDefaultWorkItemsReader, type WorkItemsReader } from "../../connectors/work-items.js";
import { defineRoute, type ApiRoute } from "../route.js";
import { allowedWorkItemFields, type WorkItemFieldAllowance } from "../work-item-fields.js";

/** Routes over a reader and a field allowance; tests pass their own. */
export function createWorkItemRoutes(deps: {
  getReader: () => WorkItemsReader | null;
  allowedFields?: WorkItemFieldAllowance;
}): readonly ApiRoute[] {
  const allowance = deps.allowedFields ?? allowedWorkItemFields;
  const reader = (): WorkItemsReader => {
    const value = deps.getReader();
    // No connector key on this server: no tracker connection can exist.
    if (!value) throw new ApiError("no_source", "Tracker connectors are not set up on this server.");
    return value;
  };
  /** The named custom fields, each one the actor may read, or not_granted. */
  const fields = (actor: ApiActor, named: string | string[] | undefined): string[] | undefined => {
    if (named === undefined) return undefined;
    const list = typeof named === "string" ? [named] : named;
    const allowed = allowance(actor);
    const refused = allowed === null ? [] : list.filter((field) => !allowed.includes(field));
    if (refused.length) {
      throw new ApiError("not_granted", `This caller may not read the custom field ${refused[0]}; a page reads only the fields its manifest names.`);
    }
    return list;
  };
  return [
    defineRoute(searchWorkItems, (input, { room, actor }) => reader().search(room.id, { ...input, fields: fields(actor, input.fields) })),
    defineRoute(getWorkItem, (input, { room, actor }) => reader().get(room.id, { ...input, fields: fields(actor, input.fields) })),
    defineRoute(getWorkItemHistory, (input, { room }) => reader().history(room.id, input)),
  ];
}

// Routes for the methods in shared/api/work-items.mjs, made with defineRoute.
export const routes: readonly ApiRoute[] = createWorkItemRoutes({ getReader: getDefaultWorkItemsReader });

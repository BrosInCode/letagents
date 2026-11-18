import { ApiError } from "../../../../shared/api/core.mjs";
import { getWorkItem, getWorkItemHistory, searchWorkItems } from "../../../../shared/api/work-items.mjs";
import { getDefaultWorkItemsReader, type WorkItemsReader } from "../../connectors/work-items.js";
import { defineRoute, type ApiRoute } from "../route.js";

/** Routes over a reader; tests pass one with stub providers. */
export function createWorkItemRoutes(getReader: () => WorkItemsReader | null): readonly ApiRoute[] {
  const reader = (): WorkItemsReader => {
    const value = getReader();
    // No connector key on this server: no tracker connection can exist.
    if (!value) throw new ApiError("no_source", "Tracker connectors are not set up on this server.");
    return value;
  };
  return [
    defineRoute(searchWorkItems, (input, { room }) => reader().search(room.id, input)),
    defineRoute(getWorkItem, (input, { room }) => reader().get(room.id, input)),
    defineRoute(getWorkItemHistory, (input, { room }) => reader().history(room.id, input)),
  ];
}

// Routes for the methods in shared/api/work-items.mjs, made with defineRoute.
export const routes: readonly ApiRoute[] = createWorkItemRoutes(getDefaultWorkItemsReader);

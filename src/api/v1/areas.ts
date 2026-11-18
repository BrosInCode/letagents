import type { ApiRoute } from "./route.js";
import { routes as agents } from "./areas/agents.js";
import { routes as data } from "./areas/data.js";
import { routes as events } from "./areas/events.js";
import { routes as git } from "./areas/git.js";
import { routes as intents } from "./areas/intents.js";
import { routes as jobs } from "./areas/jobs.js";
import { routes as memory } from "./areas/memory.js";
import { routes as messages } from "./areas/messages.js";
import { routes as pages } from "./areas/pages.js";
import { routes as people } from "./areas/people.js";
import { routes as planning } from "./areas/planning.js";
import { routes as rooms } from "./areas/rooms.js";
import { routes as tasks } from "./areas/tasks.js";
import { routes as workItems } from "./areas/work-items.js";

/**
 * The mount list: every /api/v1 route. Each area keeps its routes in its own
 * file under ./areas, so parallel changes to different areas never touch
 * this list; it changes only when a new area is added.
 */
export const API_V1_ROUTES: readonly ApiRoute[] = [
  ...rooms,
  ...people,
  ...agents,
  ...messages,
  ...tasks,
  ...planning,
  ...workItems,
  ...git,
  ...memory,
  ...data,
  ...intents,
  ...jobs,
  ...events,
  ...pages,
];

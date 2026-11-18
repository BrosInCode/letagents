// Every LetAgents API method, from every area. Areas add methods in their own
// module; this list already names every area, so it changes only for a new one.
import * as agents from "./agents.mjs";
import * as data from "./data.mjs";
import * as events from "./events.mjs";
import * as git from "./git.mjs";
import * as intents from "./intents.mjs";
import * as jobs from "./jobs.mjs";
import * as memory from "./memory.mjs";
import * as messages from "./messages.mjs";
import * as pages from "./pages.mjs";
import * as people from "./people.mjs";
import * as planning from "./planning.mjs";
import * as rooms from "./rooms.mjs";
import * as tasks from "./tasks.mjs";
import * as workItems from "./work-items.mjs";

export { API_VERSION, ApiError, defineMethod, toJsonSchema } from "./core.mjs";

/**
 * Written out so the declaration names each area's list instead of repeating
 * every schema type.
 * @typedef {typeof rooms.methods[number] | typeof people.methods[number] | typeof agents.methods[number]
 *   | typeof messages.methods[number] | typeof tasks.methods[number] | typeof planning.methods[number]
 *   | typeof workItems.methods[number] | typeof git.methods[number] | typeof memory.methods[number]
 *   | typeof data.methods[number] | typeof intents.methods[number] | typeof jobs.methods[number]
 *   | typeof events.methods[number] | typeof pages.methods[number]} KnownApiMethod
 */

/** @type {readonly KnownApiMethod[]} */
export const API_METHODS = Object.freeze([
  ...rooms.methods,
  ...people.methods,
  ...agents.methods,
  ...messages.methods,
  ...tasks.methods,
  ...planning.methods,
  ...workItems.methods,
  ...git.methods,
  ...memory.methods,
  ...data.methods,
  ...intents.methods,
  ...jobs.methods,
  ...events.methods,
  ...pages.methods,
]);

/** @typedef {KnownApiMethod["name"]} ApiMethodName */

assertUniqueMethods(API_METHODS);

/** @type {ReadonlyMap<string, KnownApiMethod>} */
export const API_METHODS_BY_NAME = new Map(API_METHODS.map((method) => [method.name, method]));

/**
 * @param {string} name
 * @returns {KnownApiMethod | undefined}
 */
export function getApiMethod(name) {
  return API_METHODS_BY_NAME.get(name);
}

/**
 * Two methods with one name, or one HTTP route, would make the contract and
 * the server disagree about which one a call means.
 * @param {ReadonlyArray<{ name: string, httpMethod: string, path: string }>} methods
 */
export function assertUniqueMethods(methods) {
  const names = new Set();
  const routes = new Map();
  for (const method of methods) {
    if (names.has(method.name)) throw new Error(`Two API methods are named ${JSON.stringify(method.name)}.`);
    names.add(method.name);
    // `/rooms/:room/tasks/:taskId` and `/rooms/:room/tasks/:id` are one route.
    const route = `${method.httpMethod} ${method.path.replace(/:[A-Za-z0-9_]+/g, ":")}`;
    const other = routes.get(route);
    if (other) throw new Error(`API methods ${JSON.stringify(other)} and ${JSON.stringify(method.name)} share the route ${route}.`);
    routes.set(route, method.name);
  }
}

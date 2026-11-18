# LetAgents API: adding a method

The LetAgents API has one contract, in `shared/api/`. The server routes, client types,
the page bridge and MCP tool schemas all come from it. The plan is
`docs/plans/letagents-api.md`.

## Where things are

| What | Where |
|---|---|
| Method, error shape, rate classes, `API_VERSION` | `shared/api/core.mjs` |
| Capabilities, grant-sheet labels, default policies | `shared/api/capabilities.mjs` |
| Actor shape `{ principal, via?, roomId }` | `shared/api/actor.mjs` |
| Page manifest schema and parser | `shared/api/manifest.mjs` |
| Methods of one area | `shared/api/<area>.mjs` (`work-items.mjs` for `work_items`) |
| All methods | `shared/api/index.mjs` (`API_METHODS`, `getApiMethod`) |
| Generated types | `shared/api/*.d.mts` (never edit by hand) |
| Compatibility snapshot | `shared/api/__snapshots__/<area>.json` |
| Routes of one area | `src/api/v1/areas/<area>.ts` |
| Mount list | `src/api/v1/areas.ts` (`API_V1_ROUTES`) |
| Route pipeline | `src/api/v1/router.ts`, `defineRoute` in `src/api/v1/route.ts` |
| Actor resolver | `src/api/v1/actor.ts` (`resolveApiActor`) |
| Capability check | `src/api/v1/capability.ts` (`checkCapability`) |

## Add a method

1. **Contract.** In `shared/api/<area>.mjs`, describe the method and add it to `methods`:

   ```js
   export const getTask = defineMethod({
     name: "tasks.get",                 // <area>.<verb>
     area: "tasks",
     kind: "read",                      // read | intent | job | write
     capability: "tasks.read",          // must exist in capabilities.mjs
     description: "One board task by id, with status, assignees and PR links.",
     path: "/rooms/:room/tasks/:taskId", // always starts with /rooms/:room
     input: z.strictObject({ taskId: z.string() }),
     output: Task,
     errors: ["not_found"],             // codes beyond the common ones
     rateClass: "read",                 // read | search | write | post | intent | job
   });
   export const methods = /** @type {const} */ ([getTask]);
   ```

   - A read is a `GET`; other kinds default to `POST` (set `httpMethod` for `PUT`, `PATCH`, `DELETE`).
   - `GET` and `DELETE` read input from the query string, so numbers need `z.coerce.number()`.
     Other verbs read the JSON body. Path parameters other than `:room` are input fields.
   - Use `z.strictObject` for inputs, so a misspelled field is an error, not ignored.
   - Use camelCase field names. Export each schema and a same-named type:
     `/** @typedef {z.infer<typeof Task>} Task */`.
   - The description is what agents read in the MCP tool. Write it for them.
   - Common codes need no listing: `invalid_input`, `unauthenticated`, `not_found` (the room),
     `not_participant`, `not_granted`, `rate_limited`, `source_unavailable`, `internal`. List
     `not_found` anyway when the method can miss its own target, so the reference says so.

2. **Route.** In `src/api/v1/areas/<area>.ts`, add the handler to `routes`:

   ```ts
   export const routes: readonly ApiRoute[] = [
     defineRoute(getTask, async ({ taskId }, { room, actor }) => {
       const task = await loadTask(room.id, taskId);
       if (!task) throw new ApiError("not_found", "No task with this id in this room.");
       return toTask(task);
     }),
   ];
   ```

   The router already did these steps, in this order: sign-in, room access through the room in
   the URL (`not_found`, `not_participant`), `checkCapability`, the per-actor rate limit, and the
   input parse. The handler gets the parsed input and `{ actor, room, access, account, req }`.
   Throw `ApiError` for an expected refusal. Any other error is answered as `internal`, and the
   detail goes only to the server log. Outside production the router also checks the output
   against the schema, and refuses an error code the method does not list.

3. **Generate.** Run `node scripts/build-api-contracts.mjs`. It type-checks the contract,
   writes the `.d.mts` files and refreshes the snapshot. It refuses to refresh the snapshot when
   the change removes a method or a field, or narrows a type: inside `api: 1` the contract only
   grows. Commit the generated files with the change.

4. **Test.** Add a route test (see `src/api/__tests__/api-v1-rooms-db.test.ts`) and run:

   ```sh
   node --test scripts/build-api-contracts.test.mjs   # declarations and snapshot current, no break
   node --import tsx --test src/api/__tests__/api-contract.test.ts src/api/__tests__/api-v1-router.test.ts
   ```

## Wire format

- Room ids are one path segment: encode them (`github.com%2Fowner%2Frepo`).
- A success is `200` with the output as the body.
- An error is `{ code, message, retryAfterMs? }` with the status from `API_ERROR_HTTP_STATUS`.
  `rate_limited` and `source_unavailable` also send `Retry-After` in seconds.
- Clients must accept output fields and enum values that they do not know yet: those are
  additions, and additions do not change `api: 1`.

## Use the types in a client

The `.d.mts` files are plain TypeScript declarations:

```ts
import type { RoomSummary } from "../../../shared/api/rooms.mjs";
import type { ApiErrorBody, ApiErrorCode } from "../../../shared/api/core.mjs";
```

This works from the server (`tsconfig.json`), the desktop main process
(`apps/desktop/tsconfig.electron.json`) and the web app (`src/web`). An MCP tool takes its input
schema from `toJsonSchema(method).input`.

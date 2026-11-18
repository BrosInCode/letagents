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
| Route pipeline | `src/api/v1/router.ts`; `defineRoute`, `defineStreamRoute`, `withStatus` in `src/api/v1/route.ts` |
| Caller and room access | `src/api/v1/actor.ts` (`identifyCaller`, `resolveRoomAccess`) |
| Capability check | `src/api/v1/capability.ts` (`checkCapability`) |
| Types for those steps | `src/api/v1/context.ts` |
| Page grants (mint, refresh, revoke) | `src/api/v1/page-grants.ts` |
| Room policy (`resolvePolicy`, `resolveCallPolicy`) | `src/api/v1/policy.ts`, `src/api/v1/capability.ts` |
| Action record (`api_actions`) | `src/api/v1/actions.ts` |

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
   - `GET` and `DELETE` read input from the query string. Use `queryInt({ min, max, default? })`
     and `queryBool({ default? })` from `core.mjs` for numbers and booleans: they take the JSON
     value (MCP, the page bridge) and its exact text (`"20"`, `"true"`). A plain `z.number()`,
     `z.coerce.number()` or `z.boolean()` there fails the contract test. Other verbs read the
     JSON body. Path parameters other than `:room` are input fields.
   - Two routes for one verb must not match the same URL: `/tasks/:taskId` and `/tasks/search`
     are refused at load. Use another fixed segment (`/task-search`).
   - `response: "stream"` marks a method whose handler writes the response itself (server-sent
     events); its `output` describes one event. The default is `"json"`.
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

   The router runs these steps, in this order, before and after the handler:
   1. `identifyCaller(req)`: who calls (`unauthenticated` when nobody).
   2. The rate limit for the method's `rateClass`, per caller, across rooms (`rate_limited`).
   3. `resolveRoomAccess(caller, roomParam)`: the room in the URL (`not_found`, `not_participant`).
   4. The input parse (`invalid_input`).
   5. `checkCapability(actor, method, input, call)`, with the parsed input (`not_granted`).
   6. The handler, with the parsed input and `{ actor, room, access, account, req }`.
   7. The output parse: the answer is always the parsed output, so a field the schema does not
      name is never sent. Output that does not parse is `internal` (logged as a contract mismatch).

   Throw `ApiError` for an expected refusal. Any other error is answered as `internal`, and the
   detail goes only to the server log. Outside production, a handler error code the method does
   not list also becomes `internal`, so the test shows it.

   - `return withStatus(201, output)` answers 201 (or 202). There is no 204: every method has an
     output schema.
   - For a `response: "stream"` method, use
     `defineStreamRoute(method, async (input, call, res) => { ... })`. Steps 1 to 5 run first; the
     handler then owns `res` and resolves when the stream ends.

3. **Generate.** Run `node scripts/build-api-contracts.mjs`. It type-checks the contract,
   writes the `.d.mts` files and refreshes the snapshot. It refuses to refresh the snapshot when
   the change removes a method or a field, narrows a type, or changes the path, verb, capability,
   rate class or response kind: inside `api: 1` the contract only grows. Commit the generated
   files with the change. The test also compares with the snapshot on the base branch
   (`API_CONTRACT_BASE_REF`, default `origin/feat/letagents-api`), so `--allow-breaking` on a
   feature branch does not get a break past review.

4. **Test.** Add a route test (see `src/api/__tests__/api-v1-rooms-db.test.ts`) and run:

   ```sh
   node --test scripts/build-api-contracts.test.mjs   # declarations and snapshot current, no break
   node --import tsx --test src/api/__tests__/api-contract.test.ts src/api/__tests__/api-v1-router.test.ts
   ```

## Callers, grants and policy

- Callers: an app session or owner token is a person; a remote MCP session's call is a person
  `via: integration remote-mcp`; a worker bearer is an agent in its own room (GET only); a
  `page_grant` bearer (`lapg.<hex>`) is the person `via: page` (id and version) in one room.
  A `page_grant` is refused on every path outside `/api/v1`.
- The capability check: a page needs the capability in its grant, for its page version and room.
  Anything that is not a read then reads the room policy; `deny` is `not_granted`. `confirm` and
  `approve` pass to the handler, which calls `resolveCallPolicy(call, capability)` and acts on
  `mode` (a confirm sheet, a pending intent). `confirm` applies only to calls through a page.
- Minting: `requirePageGrantMinter(req)` (an app session only), then `mintPageGrant({ minter,
  roomId, pageId, pageVersion, capabilities })`. `revokePageGrants({ pageId?, roomId?,
  accountId?, grantId? })` revokes and closes the grants' streams; sign-out calls it.
- The router appends every non-read call that passed the room check to `api_actions`. A handler
  names its target with `setApiActionTarget(call, target)`; otherwise the path parameters are used.

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

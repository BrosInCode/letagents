import assert from "node:assert/strict";
import test from "node:test";

import { readJevEndpoint, readJevRoutingConfig, type JevEndpoint } from "../messages/jev-conversation-routing.js";
import { parseCommandReviewInput, reviewCommands } from "../permissions/command-review.js";
import { isSupervisorGrantRouteAllowed } from "../request/supervisor-grant-route-registry.js";

// The route's module opens a database pool when it loads. These tests never use it.
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerCommandReviewRoutes } = await import("../routes/command-reviews.js");

const endpoint: JevEndpoint = { provider: "typesafe", apiKey: "key", baseUrl: "https://jev.example", model: "jev-latest", timeoutMs: 4_000 };
const project = "/Users/dev/shop-api";
const answer = (read: number, check: number, edit: number, risky: number) => {
  const probabilities = { read, check, edit, risky };
  const choice = (Object.keys(probabilities) as Array<keyof typeof probabilities>)
    .reduce((best, kind) => probabilities[kind] > probabilities[best] ? kind : best);
  return { answers: { kind: { type: "choice", choice, probabilities }, off_task: { type: "noul", noul: 0 } } };
  // A provider that answers a question nobody asked changes nothing.
};

test("a command reserved for a person never reaches Jev", async () => {
  let calls = 0;
  const evaluate = async () => { calls += 1; return { body: answer(1, 0, 0, 0), latencyMs: 1 }; };
  for (const commands of [["git push"], ["ls", "rm -rf build"], ["cat .env"], ["ls .."], ["curl https://example.com"], ["echo $(whoami)"]]) {
    assert.deepEqual(await reviewCommands({ commands, project }, { endpoint, evaluate }),
      { decision: "ask", reason: "needs_person", answers: null });
  }
  assert.deepEqual(await reviewCommands({ commands: ["ls"], project: "shop-api" }, { endpoint, evaluate }),
    { decision: "ask", reason: "needs_person", answers: null });
  assert.equal(calls, 0);
});

test("Jev is sent the commands and the project, and nothing else", async () => {
  const sent: Array<{ state: unknown; questions: Record<string, unknown> }> = [];
  const evaluate = async (_endpoint: JevEndpoint, request: { state: unknown; questions: Record<string, unknown> }) => {
    sent.push(request);
    return { body: answer(0.02, 0.97, 0.01, 0), latencyMs: 1 };
  };
  const result = await reviewCommands({ commands: ["npm test", "git diff"], project }, { endpoint, evaluate });
  assert.equal(result.decision, "allow");
  assert.equal(result.reason, "reviewed");
  assert.deepEqual(sent.map((request) => request.state), [{ commands: ["npm test", "git diff"], project }]);
  assert.deepEqual(Object.keys(sent[0]!.questions), ["kind"]);
});

test("only a confident reading or checking answer allows, and a change to files asks", async () => {
  for (const [body, decision] of [
    [answer(0.95, 0.03, 0.02, 0), "allow"],
    [answer(0, 0.9, 0.1, 0), "allow"],
    [answer(0.5, 0.4, 0, 0.1), "allow"],
    [answer(0.5, 0.39, 0, 0.11), "ask"],
    [answer(0.5, 0.39, 0.11, 0), "ask"],
    // A change to project files asks, whatever the answer says about a task.
    [answer(0, 0, 1, 0), "ask"],
    [answer(0, 0, 0, 1), "ask"],
    // The model picked one kind and scored another highest.
    [{ answers: { kind: { choice: "risky", probabilities: { read: 1, check: 0, edit: 0, risky: 0 } } } }, "ask"],
    [{ answers: { kind: { probabilities: { read: 1 } } } }, "ask"],
    [{ answers: {} }, "ask"],
    [null, "ask"],
    ["allow", "ask"],
    [{ decision: "allow" }, "ask"],
  ] as const) {
    const result = await reviewCommands({ commands: ["ls"], project }, { endpoint, evaluate: async () => ({ body, latencyMs: 1 }) });
    assert.equal(result.decision, decision, JSON.stringify(body));
    assert.equal(result.reason, "reviewed");
  }
});

test("no credential, a timeout, or a provider error asks a person", async () => {
  assert.deepEqual(await reviewCommands({ commands: ["ls"], project }, { endpoint: null, evaluate: async () => { throw new Error("must not be called"); } }),
    { decision: "ask", reason: "unavailable", answers: null });
  assert.deepEqual(await reviewCommands({ commands: ["ls"], project }, { endpoint, evaluate: async () => { throw new Error("Jev evaluation failed: HTTP 500"); } }),
    { decision: "ask", reason: "unavailable", answers: null });
});

test("the review request accepts exactly its two fields", () => {
  assert.deepEqual(parseCommandReviewInput({ commands: ["ls"], project }), { commands: ["ls"], project });
  for (const value of [
    null, [], "ls", {}, { commands: ["ls"] }, { project }, { commands: [], project }, { commands: "ls", project },
    { commands: [7], project }, { commands: [""], project }, { commands: ["x".repeat(2_001)], project },
    { commands: Array.from({ length: 17 }, () => "ls"), project }, { commands: ["ls"], project: "" },
    { commands: ["ls"], project: "x".repeat(1_025) }, { commands: ["ls"], project, task: "anything" },
    { commands: ["ls"], project, decision: "allow" },
  ]) assert.equal(parseCommandReviewInput(value), null, JSON.stringify(value)?.slice(0, 80));
});

test("a supervisor grant may ask for a review and nothing nearby", () => {
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/supervisor-host-grants/grant/command-reviews"), true);
  assert.equal(isSupervisorGrantRouteAllowed("GET", "/supervisor-host-grants/grant/command-reviews"), false);
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/supervisor-host-grants/grant/command-reviews/extra"), false);
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/supervisor-host-grants/a/b/command-reviews"), false);
});

test("the Jev endpoint is read from the credential alone, and routing keeps its own switch", () => {
  assert.equal(readJevEndpoint({}), null);
  assert.deepEqual(readJevEndpoint({ TYPESAFE_API_KEY: " key ", TYPESAFE_BASE_URL: "https://openrouter.ai/api/v1/" }),
    { provider: "typesafe", apiKey: "key", baseUrl: "https://openrouter.ai/api/v1", model: "jev-latest", timeoutMs: 4_000 });
  assert.equal(readJevEndpoint({ AI_GATEWAY_API_KEY: "key" })?.provider, "gateway");
  assert.deepEqual(readJevRoutingConfig({ TYPESAFE_API_KEY: "key" }), { status: "off" });
  assert.deepEqual(readJevRoutingConfig({ LETAGENTS_JEV_ROUTING: "active" }), { status: "missing_api_key", mode: "active" });
  assert.deepEqual(readJevRoutingConfig({ LETAGENTS_JEV_ROUTING: "active", TYPESAFE_API_KEY: "key" }), {
    status: "enabled",
    config: { mode: "active", provider: "typesafe", apiKey: "key", baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", timeoutMs: 4_000 },
  });
});

type Handler = (req: Record<string, unknown>, res: ReturnType<typeof response>) => Promise<void>;

function response() {
  const sent = { status: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  const res = {
    sent,
    status(code: number) { sent.status = code; return res; },
    json(body: unknown) { sent.body = body; return res; },
    setHeader(name: string, value: string) { sent.headers[name.toLowerCase()] = value; return res; },
  };
  return res;
}

async function routeFixture(options: { enabled?: boolean; grantRefused?: boolean; review?: () => Promise<unknown> } = {}) {
  const previous = process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED;
  process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED = options.enabled === false ? "" : "1";
  const routes: Array<{ path: string; handler: Handler }> = [];
  const reviewed: unknown[] = [];
  const grants: unknown[] = [];
  try {
    registerCommandReviewRoutes({ post: (path: string, handler: Handler) => { routes.push({ path, handler }); } } as never, {
      resolveCanonicalRoomRequestId: async (roomId: string) => roomId === "alias" ? "room" : roomId,
      reviewCommands: (async (input: unknown) => {
        reviewed.push(input);
        return options.review ? options.review() : { decision: "allow", reason: "reviewed", answers: { kinds: { read: 1, check: 0, edit: 0, risky: 0 } } };
      }) as never,
      requireCurrentSupervisorGrant: (async (_req: unknown, res: ReturnType<typeof response>, _deps: unknown, policy: unknown) => {
        grants.push(policy);
        if (!options.grantRefused) return { grant_id: "grant" };
        res.status(409).json({ error: "Supervisor grant fence is stale." });
        return null;
      }) as never,
    } as never);
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED;
    else process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED = previous;
  }
  const request = (change: Record<string, unknown> = {}) => ({ authKind: "supervisor_grant", supervisorGrant: { grant_id: "grant" },
    params: { grantId: "grant" }, body: { room_id: "room", commands: ["npm test"], project }, ...change });
  const send = async (change: Record<string, unknown> = {}) => {
    const res = response();
    await routes[0]!.handler(request(change), res);
    return res.sent;
  };
  return { routes, reviewed, grants, send };
}

test("the review route answers a current grant for the agent's own room, and says only the decision", async () => {
  const f = await routeFixture();
  assert.deepEqual(f.routes.map(route => route.path), ["/supervisor-host-grants/:grantId/command-reviews"]);
  assert.deepEqual(await f.send(), { status: 200, body: { decision: "allow", reason: "reviewed" }, headers: { "cache-control": "no-store" } });
  assert.deepEqual(f.reviewed, [{ commands: ["npm test"], project }]);
  assert.deepEqual(f.grants, [{ kind: "rooms", room_ids: ["room"] }]);
});

test("the review route reviews nothing for a caller it cannot vouch for", async () => {
  const f = await routeFixture();
  for (const change of [{ authKind: "agent_session" }, { authKind: "session" }, { authKind: "owner_token" }, { authKind: undefined },
    { supervisorGrant: undefined }, { supervisorGrant: { grant_id: "another" } }, { params: { grantId: "another" } }]) {
    assert.equal((await f.send(change)).status, 403, JSON.stringify(change));
  }
  for (const body of [undefined, null, [], "npm test", {}, { commands: ["npm test"], project }, { room_id: "", commands: ["npm test"], project },
    { room_id: 7, commands: ["npm test"], project }, { room_id: "r".repeat(513), commands: ["npm test"], project },
    { room_id: "room", commands: [], project }, { room_id: "room", commands: "npm test", project }, { room_id: "room", commands: ["npm test"] },
    { room_id: "room", commands: ["npm test"], project, task: "said by a room message" },
    // A room named by anything but its canonical id.
    { room_id: "alias", commands: ["npm test"], project }]) {
    assert.equal((await f.send({ body })).status, 400, JSON.stringify(body)?.slice(0, 80));
  }
  assert.deepEqual(f.reviewed, []);
  assert.deepEqual(f.grants, [], "a request that is refused for its shape never reaches the grant check");

  const refused = await routeFixture({ grantRefused: true });
  assert.deepEqual(await refused.send(), { status: 409, body: { error: "Supervisor grant fence is stale." }, headers: {} });
  assert.deepEqual(refused.reviewed, []);
});

test("a review that fails says so without repeating the commands", async () => {
  const f = await routeFixture({ review: async () => { throw new Error("npm test could not be sent"); } });
  const sent = await f.send();
  assert.equal(sent.status, 500);
  assert.equal(JSON.stringify(sent.body).includes("npm test"), false);
});

test("the review route does not exist where supervisor grants are turned off", async () => {
  assert.deepEqual((await routeFixture({ enabled: false })).routes, []);
});

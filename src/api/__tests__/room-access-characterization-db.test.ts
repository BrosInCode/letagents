/**
 * Characterization of every "may this principal read / administer this room"
 * call site, against a real database and a fake GitHub.
 *
 * Each cell builds its own world (fresh room ids, fresh logins, cold GitHub
 * caches), calls ONE call site, and records its answer in a short string. The
 * whole table is compared with the pinned answers in
 * fixtures/room-access-characterization.json. The pinned answers were taken on
 * staging before the access decision moved into one module; the refactor must
 * keep every cell the same.
 *
 * Regenerate (only for a deliberate, reviewed behaviour change):
 *   UPDATE_ROOM_ACCESS_CHARACTERIZATION=1 TEST_DB_URL=... node --import tsx --test <this file>
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { Project, SessionAccount, SupervisorHostGrant } from "../db/types.js";
import type { AuthenticatedRequest } from "../http/helpers.js";

const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the room access characterization";
// Worker bearers are resolved from the database at the live re-check.
process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = "true";

const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const ownerTokens = testDatabaseUrl ? await import("../db/auth/owner-tokens.js") : null;
const bindings = testDatabaseUrl ? await import("../db/git-room-bindings.js") : null;
const roomsDb = testDatabaseUrl ? await import("../db/rooms.js") : null;
const access = testDatabaseUrl ? await import("../rooms/access.js") : null;
const liveDemos = testDatabaseUrl ? await import("../live-demos/access.js") : null;
const events = testDatabaseUrl ? await import("../server/events.js") : null;
const pushWorker = testDatabaseUrl ? await import("../notifications/worker.js") : null;
const attention = testDatabaseUrl ? await import("../account-unread/attention.js") : null;
const engine = testDatabaseUrl ? await import("../connectors/rules/engine.js") : null;
const agentAsks = testDatabaseUrl ? await import("../routes/agent-asks.js") : null;
const supervisorGrants = testDatabaseUrl ? await import("../routes/supervisor-host-grants.js") : null;
const roomList = testDatabaseUrl ? await import("../account-room-membership/list.js") : null;
const repoAccessModule = testDatabaseUrl ? await import("../github/repo-access.js") : null;
const agentSessions = testDatabaseUrl ? await import("../db/auth/room-agent-sessions.js") : null;
const supervisorGrantStore = testDatabaseUrl ? await import("../db/auth/supervisor-grants.js") : null;
const jevLinkRoutes = testDatabaseUrl ? await import("../routes/rooms/jev-links.js") : null;

const FIXTURE = path.resolve(process.cwd(), "src/api/__tests__/fixtures/room-access-characterization.json");

// ---------------------------------------------------------------- fake GitHub

type GitHubRole = "none" | "read" | "triage" | "admin";
const repos = new Map<string, { private: boolean; roles: Map<string, GitHubRole> }>();
let githubDown = false;
/** Other ways GitHub gives no answer: a dead token (401) or an exhausted rate limit (403). */
let githubFailure: null | "401" | "ratelimit" = null;
const githubCalls: string[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function permissionsFor(role: GitHubRole) {
  return {
    pull: true,
    triage: role === "triage" || role === "admin",
    push: role === "admin",
    maintain: role === "admin",
    admin: role === "admin",
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const token = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
  githubCalls.push(`${token || "anon"} ${url.pathname}`);
  if (githubDown) return json(503, { message: "unavailable" });
  if (githubFailure === "401" && token) return json(401, { message: "Bad credentials" });
  if (githubFailure === "ratelimit") {
    return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
      },
    });
  }
  const match = /^\/repos\/acme\/([^/]+)(?:\/collaborators\/([^/]+)\/permission)?$/.exec(url.pathname);
  const repo = match ? repos.get(match[1]!.toLowerCase()) : undefined;
  if (!match || !repo) return json(404, { message: "Not Found" });
  const login = token.startsWith("gh-") ? token.slice(3) : null;
  const role: GitHubRole = login ? repo.roles.get(login) ?? "none" : "none";
  if (match[2] !== undefined) {
    if (!login || role === "none") return json(404, { message: "Not Found" });
    const permission = role === "admin" ? "admin" : "read";
    return json(200, { permission, role_name: role });
  }
  if (repo.private && role === "none") return json(404, { message: "Not Found" });
  return json(200, {
    private: repo.private,
    owner: { login: "acme" },
    ...(login ? { permissions: repo.private ? permissionsFor(role) : permissionsFor(role) } : {}),
  });
}) as typeof fetch;

// ---------------------------------------------------------------- the table

const ROOM_KINDS = [
  "membership",
  "membership_focus",
  "repo_private",
  "repo_public",
  "repo_focus",
  "bound_private",
  "unsupported_host",
] as const;
type RoomKind = typeof ROOM_KINDS[number];

/**
 * Room kinds added after the first pin (their rows are prefixed `x:`):
 * - bound_ghe_host: a binding with provider github on a host other than github.com
 * - bound_focus_membership_parent: a focus room with its own GitHub binding under a membership room
 */
const EXTRA_ROOM_KINDS = ["bound_ghe_host", "bound_focus_membership_parent"] as const;
type AnyRoomKind = RoomKind | typeof EXTRA_ROOM_KINDS[number];
const REPO_ROOM_KINDS = ["repo_private", "repo_public", "repo_focus", "bound_private"] as const;

/**
 * - stranger: signed in, no row, no GitHub role
 * - member: a member row on the access room, GitHub read
 * - triage: a member row, GitHub triage
 * - gh_admin: no row, GitHub admin
 * - stale_admin: an admin row on the room and its access room, no GitHub role
 * - admin_row_gh_read: an admin row on the room and its access room, GitHub read
 * - focus_admin_row_only: an admin row on the room only (not its access room), no member row, GitHub read
 * - no_token: a member row and GitHub read, but no stored GitHub token
 */
const PRINCIPALS = [
  "anonymous",
  "stranger",
  "member",
  "triage",
  "gh_admin",
  "stale_admin",
  "admin_row_gh_read",
  "focus_admin_row_only",
  "no_token",
] as const;
type PrincipalKind = typeof PRINCIPALS[number];

const CALL_SITES = [
  "participant",
  "participant_fresh",
  "participant_strict",
  "admin_route",
  "role",
  "is_current_admin",
  "live_recheck",
  "live_demo",
  "push_emit",
  "push_delivery",
  "attention",
  "tracker_admin_stored_row",
  "tracker_admin_throw",
  "agent_ask_admin",
  "supervisor_grant",
  "room_list",
] as const;
type CallSite = typeof CALL_SITES[number];

let serial = 0;

interface World {
  project: Project;
  accessRoomId: string;
  repoRoomName: string | null;
  login: string | null;
  accountId: string | null;
  sessionToken: string | null;
  sessionAccount: SessionAccount | null;
  ownerToken?: string;
}

async function insertMainRoom(id: string): Promise<void> {
  await dbClient!.pool.query(
    `INSERT INTO rooms (id, created_at, display_name, kind) VALUES ($1, NOW(), $1, 'main')`,
    [id],
  );
}

async function insertFocusRoom(parentId: string): Promise<string> {
  const id = `focus_${100000 + serial}`;
  await dbClient!.pool.query(
    `INSERT INTO rooms (id, created_at, display_name, kind, parent_room_id, focus_key, focus_status)
     VALUES ($1, NOW(), $1, 'focus', $2, $1, 'active')`,
    [id, parentId],
  );
  return id;
}

async function insertBinding(roomId: string, input: { provider: string; host: string; name: string }): Promise<void> {
  await bindings!.upsertGitRoomBinding({
    room_id: roomId,
    provider: input.provider,
    host: input.host,
    repository_full_name: `acme/${input.name}`,
    repository_owner: "acme",
    repository_name: input.name,
    ref_type: "branch",
    ref_name: "main",
    visibility: "private",
    source: "manual",
  } as never);
}

async function buildWorld(roomKind: AnyRoomKind, principal: PrincipalKind): Promise<World> {
  serial += 1;
  const n = serial;
  let roomId: string;
  let accessRoomId: string;
  let repoName: string | null = null;
  let repoPrivate = true;
  switch (roomKind) {
    case "membership":
      roomId = accessRoomId = `char-m-${n}`;
      await insertMainRoom(roomId);
      break;
    case "membership_focus":
      accessRoomId = `char-mp-${n}`;
      await insertMainRoom(accessRoomId);
      roomId = await insertFocusRoom(accessRoomId);
      break;
    case "repo_private":
      repoName = `priv-${n}`;
      roomId = accessRoomId = `github.com/acme/${repoName}`;
      await insertMainRoom(roomId);
      break;
    case "repo_public":
      repoName = `pub-${n}`;
      repoPrivate = false;
      roomId = accessRoomId = `github.com/acme/${repoName}`;
      await insertMainRoom(roomId);
      break;
    case "repo_focus":
      repoName = `privf-${n}`;
      accessRoomId = `github.com/acme/${repoName}`;
      await insertMainRoom(accessRoomId);
      roomId = await insertFocusRoom(accessRoomId);
      break;
    case "bound_private":
      repoName = `bound-${n}`;
      roomId = accessRoomId = `char-b-${n}`;
      await insertMainRoom(roomId);
      await bindings!.upsertGitRoomBinding({
        room_id: roomId,
        provider: "github",
        host: "github.com",
        repository_full_name: `acme/${repoName}`,
        repository_owner: "acme",
        repository_name: repoName,
        ref_type: "branch",
        ref_name: "main",
        visibility: "private",
        source: "manual",
      } as never);
      break;
    case "unsupported_host":
      roomId = accessRoomId = `gitlab.com/acme/x-${n}`;
      await insertMainRoom(roomId);
      break;
    case "bound_ghe_host":
      roomId = accessRoomId = `char-bg-${n}`;
      await insertMainRoom(roomId);
      await insertBinding(roomId, { provider: "github", host: "github.example.com", name: `ghe-${n}` });
      break;
    case "bound_focus_membership_parent":
      repoName = `bfocus-${n}`;
      accessRoomId = `char-bfp-${n}`;
      await insertMainRoom(accessRoomId);
      roomId = await insertFocusRoom(accessRoomId);
      await insertBinding(roomId, { provider: "github", host: "github.com", name: repoName });
      break;
  }
  const project = (await roomsDb!.getProjectById(roomId))!;
  assert.ok(project, `room ${roomId} exists`);
  const roles = new Map<string, GitHubRole>();
  const repoRoomName = repoName ? `github.com/acme/${repoName}`
    : roomKind === "bound_ghe_host" ? `github.example.com/acme/ghe-${n}` : null;
  if (repoName) repos.set(repoName.toLowerCase(), { private: repoPrivate, roles });

  if (principal === "anonymous") {
    return { project, accessRoomId, repoRoomName, login: null, accountId: null, sessionToken: null, sessionAccount: null };
  }

  const login = `c${n}-${principal.replace(/_/g, "-")}`;
  const account = await accountSessions!.upsertAccount({
    provider: "github",
    provider_user_id: `char-${n}`,
    login,
    display_name: login,
  });
  const githubToken = principal === "no_token" ? null : `gh-${login}`;
  const sessionToken = `char-session-${n}`;
  await accountSessions!.createSession(account.id, sessionToken, new Date(Date.now() + 3_600_000).toISOString(), githubToken);
  await ownerTokens!.createOwnerToken({
    accountId: account.id,
    githubUserId: `char-${n}`,
    token: `char-owner-${n}`,
    providerAccessToken: githubToken,
  });
  const addMember = (room: string) => dbClient!.pool.query(
    `INSERT INTO room_members (room_id, account_id, added_via) VALUES ($1, $2, 'seed') ON CONFLICT DO NOTHING`,
    [room, account.id],
  );
  const addAdmin = (room: string) => dbClient!.pool.query(
    `INSERT INTO project_admins (project_id, account_id, assigned_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING`,
    [room, account.id],
  );
  const role: GitHubRole = ({
    stranger: "none",
    member: "read",
    triage: "triage",
    gh_admin: "admin",
    stale_admin: "none",
    admin_row_gh_read: "read",
    focus_admin_row_only: "read",
    no_token: "read",
  } as const)[principal];
  roles.set(login.toLowerCase(), role);
  if (principal === "member" || principal === "triage" || principal === "no_token") await addMember(accessRoomId);
  if (principal === "stale_admin" || principal === "admin_row_gh_read") {
    await addAdmin(roomId);
    if (accessRoomId !== roomId) await addAdmin(accessRoomId);
  }
  if (principal === "focus_admin_row_only") await addAdmin(roomId);
  // Every person has opened the room, so the room list has it as a candidate.
  await dbClient!.pool.query(
    `INSERT INTO account_room_recents (account_id, room_id, first_opened_at, last_opened_at, updated_at)
     VALUES ($1, $2, NOW(), NOW(), NOW()) ON CONFLICT DO NOTHING`,
    [account.id, roomId],
  );
  const sessionAccount = await accountSessions!.getSessionAccountByToken(sessionToken);
  assert.ok(sessionAccount);
  return {
    project, accessRoomId, repoRoomName, login, accountId: account.id, sessionToken, sessionAccount,
    ownerToken: `char-owner-${n}`,
  };
}

function personRequest(world: World): AuthenticatedRequest {
  if (!world.sessionAccount) {
    return { headers: {}, authKind: null, sessionAccount: null, agentSession: null } as unknown as AuthenticatedRequest;
  }
  return {
    headers: { cookie: `letagents_session=${world.sessionToken}` },
    authKind: "session",
    sessionAccount: world.sessionAccount,
    agentSession: null,
  } as unknown as AuthenticatedRequest;
}

function recordingResponse() {
  const state = { status: 200, body: null as unknown };
  const res = {
    status(code: number) { state.status = code; return res; },
    json(body: unknown) { state.body = body; return res; },
    setHeader() { return res; },
  };
  return { res: res as never, state };
}

function replyCell(ok: boolean, state: { status: number; body: unknown }, world: World): string {
  if (ok) return "allow";
  const body = (state.body ?? {}) as { code?: string; error?: string; room_id?: string };
  const roomRef = body.room_id === undefined ? ""
    : body.room_id === world.project.id ? "@room"
      : body.room_id === world.accessRoomId ? "@access"
        : body.room_id === world.repoRoomName ? "@repo"
          : `@${body.room_id}`;
  return `${state.status}:${body.code ?? body.error ?? "?"}${roomRef}`;
}

async function settle(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (error) {
    return `throw:${(error as Error).name}`;
  }
}

async function callSite(site: CallSite, world: World): Promise<string> {
  const { project } = world;
  const account = world.sessionAccount;
  const needsAccount = (run: (account: SessionAccount, accountId: string) => Promise<string>) =>
    account && world.accountId ? settle(() => run(account, world.accountId!)) : Promise.resolve("-");
  switch (site) {
    case "participant":
    case "participant_fresh":
    case "participant_strict": {
      const { res, state } = recordingResponse();
      return settle(async () => replyCell(
        await access!.requireGitRoomParticipant(personRequest(world), res, project, {
          freshCollaboratorCheck: site !== "participant",
          throwOnIndeterminate: site === "participant_strict",
        }),
        state,
        world,
      ));
    }
    case "admin_route": {
      const { res, state } = recordingResponse();
      return settle(async () => replyCell(await access!.requireGitRoomAdmin(personRequest(world), res, project), state, world));
    }
    case "role":
      return settle(async () => access!.resolveGitRoomProjectRole(project, account));
    case "is_current_admin":
      return settle(async () => String(await access!.isCurrentProjectAdmin(project, account)));
    case "live_recheck":
      return settle(async () => String(await access!.reauthorizeGitRoomParticipant(personRequest(world), project)));
    case "live_demo":
      return needsAccount(async (person) => (await liveDemos!.liveDemoAccess.canView(project, person, { fresh: true })).decision);
    case "push_emit":
      return needsAccount(async (_person, accountId) => events!.resolveAccountRoomAccessForEmit({ accountId, roomId: project.id }));
    case "push_delivery":
      return needsAccount(async (_person, accountId) => pushWorker!.authorizeReminderAccess(accountId, project.id));
    case "attention":
      return needsAccount(async (person) => String(await attention!.accountMayReadRoom(project, person)));
    case "tracker_admin_stored_row":
    case "tracker_admin_throw":
      return needsAccount(async (_person, accountId) => String(await engine!.isRoomAdminAccount(project.id, accountId, {
        outage: site === "tracker_admin_throw" ? "throw" : "stored_row",
      })));
    case "agent_ask_admin":
      return needsAccount(async (person) => String(await agentAsks!.isCurrentRoomAdmin(project.id, person)));
    case "supervisor_grant":
      return needsAccount(async (_person, accountId) => {
        let revoked = false;
        const grant = {
          grant_id: `char-grant-${serial}`,
          owner_account_id: accountId,
          scope_key: "default",
          rental_session_id: null,
          allowed_room_ids: [project.id],
        } as unknown as SupervisorHostGrant;
        const { res, state } = recordingResponse();
        const ok = await supervisorGrants!.requireSupervisorGrantRoomAccess(grant, res, {
          resolveCanonicalRoomRequestId: async (roomId) => roomId,
          resolveRoomOrReply: async () => null,
          requireParticipant: async () => true,
          revokeSupervisorGrantAuthority: async () => { revoked = true; return null; },
        }, { kind: "rooms", room_ids: [project.id] });
        return `${replyCell(ok, state, world)}${revoked ? "+revoked" : ""}`;
      });
    case "room_list":
      return needsAccount(async (person, accountId) => {
        const entries = await roomList!.getAccountRoomsForAccount(accountId, { login: person.login, limit: 100 });
        const listed = entries.some((entry) => entry.room_id === project.id
          || entry.focus_rooms.some((focus) => focus.room_id === project.id));
        return listed ? "listed" : "hidden";
      });
  }
}

async function resetDatabase(): Promise<void> {
  const { db, pool } = dbClient!;
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

if (testDatabaseUrl) {
  test.before(resetDatabase);
  test.after(async () => { await dbClient?.pool.end(); });
}

test("every room access call site keeps its pinned answer", { skip, concurrency: false }, async () => {
  const table: Record<string, Record<CallSite, string>> = {};
  for (const outage of [false, true]) {
    for (const roomKind of ROOM_KINDS) {
      for (const principal of PRINCIPALS) {
        const row = {} as Record<CallSite, string>;
        for (const site of CALL_SITES) {
          const world = await buildWorld(roomKind, principal);
          githubDown = outage;
          try {
            row[site] = await callSite(site, world);
          } finally {
            githubDown = false;
          }
        }
        table[`${outage ? "outage" : "github_up"} ${roomKind} ${principal}`] = row;
      }
    }
  }

  // Worker bearers: scoped to one room; they never follow their owner.
  for (const roomKind of ROOM_KINDS) {
    for (const scope of ["same_room", "other_room"] as const) {
      const world = await buildWorld(roomKind, "anonymous");
      const worker = {
        headers: {},
        authKind: "agent_session",
        sessionAccount: null,
        agentSession: { room_id: scope === "same_room" ? world.project.id : "some-other-room" },
      } as unknown as AuthenticatedRequest;
      const row = {} as Record<CallSite, string>;
      for (const site of ["participant", "participant_fresh", "admin_route"] as const) {
        const { res, state } = recordingResponse();
        const ok = site === "admin_route"
          ? await access!.requireGitRoomAdmin(worker, res, world.project)
          : await access!.requireGitRoomParticipant(worker, res, world.project, { freshCollaboratorCheck: site === "participant_fresh" });
        row[site] = replyCell(ok, state, world);
      }
      table[`worker ${roomKind} ${scope}`] = row;
    }
  }

  const lines = Object.fromEntries(Object.entries(table).map(([key, row]) => [
    key,
    Object.entries(row).map(([site, value]) => `${site}=${value}`).join(" "),
  ]));
  pin(lines, (key) => !key.startsWith("x:"));
});

/**
 * Compares rows with the fixture. With UPDATE_ROOM_ACCESS_CHARACTERIZATION=1
 * it writes them instead, keeping every other row where it is.
 */
function pin(lines: Record<string, string>, ownsKey: (key: string) => boolean): void {
  // ROOM_ACCESS_CHARACTERIZATION_DUMP=<file>: also write this run's rows there, to list every difference at once.
  const dump = process.env.ROOM_ACCESS_CHARACTERIZATION_DUMP;
  if (dump) {
    let previous: Record<string, string> = {};
    try { previous = JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>; } catch { previous = {}; }
    writeFileSync(dump, JSON.stringify({ ...previous, ...lines }, null, 1));
  }
  let pinned: Record<string, string> = {};
  try { pinned = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, string>; } catch { pinned = {}; }
  if (process.env.UPDATE_ROOM_ACCESS_CHARACTERIZATION === "1") {
    for (const key of Object.keys(pinned)) if (ownsKey(key) && !(key in lines)) delete pinned[key];
    writeFileSync(FIXTURE, `${JSON.stringify(Object.assign(pinned, lines), null, 1)}\n`);
    return;
  }
  assert.deepEqual(Object.keys(lines), Object.keys(pinned).filter(ownsKey), "the same table rows");
  for (const key of Object.keys(lines)) {
    assert.equal(lines[key], pinned[key], `answers changed for ${key}`);
  }
}

function toLines(table: Record<string, Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(table).map(([key, row]) => [
    key,
    Object.entries(row).map(([site, value]) => `${site}=${value}`).join(" "),
  ]));
}

function credentialRequest(world: World, kind: "owner_token" | "mcp_oauth"): AuthenticatedRequest {
  // An owner token is sent as a bearer. A remote MCP OAuth session reaches the
  // routes with the account of its grant; outside the remote MCP path its
  // credential is not resolvable again, which the live re-check shows.
  return {
    headers: kind === "owner_token" ? { authorization: `Bearer ${world.ownerToken}` } : {},
    authKind: kind,
    sessionAccount: world.sessionAccount,
    agentSession: null,
  } as unknown as AuthenticatedRequest;
}

async function requestSites(req: AuthenticatedRequest, world: World): Promise<Record<string, string>> {
  const row: Record<string, string> = {};
  for (const site of ["participant", "participant_fresh", "participant_strict", "admin_route", "live_recheck"] as const) {
    const { res, state } = recordingResponse();
    row[site] = await settle(async () => {
      if (site === "admin_route") return replyCell(await access!.requireGitRoomAdmin(req, res, world.project), state, world);
      if (site === "live_recheck") return String(await access!.reauthorizeGitRoomParticipant(req, world.project));
      return replyCell(await access!.requireGitRoomParticipant(req, res, world.project, {
        freshCollaboratorCheck: site !== "participant",
        throwOnIndeterminate: site === "participant_strict",
      }), state, world);
    });
  }
  return row;
}

async function entryCell(world: World): Promise<string> {
  return settle(async () => {
    const decision = await access!.resolveProjectRoomEntryDecision({
      project: world.project, sessionAccount: world.sessionAccount, redirectTo: "/back",
    });
    if (decision.kind === "allow") return "allow";
    const reason = new URLSearchParams(decision.location.split("?")[1] ?? "").get("reason");
    return `redirect:${reason}`;
  });
}

async function jevLinkCell(world: World): Promise<string> {
  const handlers: Array<(req: unknown, res: unknown) => Promise<void>> = [];
  jevLinkRoutes!.registerJevLinkRoutes({ post: (_path: unknown, handler: never) => handlers.push(handler) } as never, {
    resolveCanonicalRoomRequestId: async (roomId) => roomId,
    resolveRoomOrReply: async () => world.project,
    requireAdmin: access!.requireGitRoomAdmin,
    jevLinks: async () => ({
      acceptLink: async () => ({ id: "task_1" }),
      rejectLink: async () => ({ id: "task_1" }),
    }) as never,
  });
  const req = {
    ...personRequest(world),
    params: { 0: encodeURIComponent(world.project.id), 1: "task_1", 2: "accept" },
    body: { pr_url: "https://github.com/acme/repo/pull/1" },
  };
  const { res, state } = recordingResponse();
  return settle(async () => {
    await handlers[0]!(req, res);
    return state.body && (state.body as { task?: unknown }).task ? "accepted" : replyCell(false, state, world);
  });
}

async function withGitHub<T>(mode: "up" | "503" | "401" | "ratelimit", run: () => Promise<T>): Promise<T> {
  githubDown = mode === "503";
  githubFailure = mode === "401" || mode === "ratelimit" ? mode : null;
  try {
    return await run();
  } finally {
    githubDown = false;
    githubFailure = null;
    repoAccessModule!.resetGitHubRepoVisibilityBackoffForTests();
  }
}

test("rows added after the first pin keep their pinned answer", { skip, concurrency: false }, async () => {
  const table: Record<string, Record<string, string>> = {};

  // GitHub answering 401 (a dead token) and an exhausted rate limit (403).
  for (const mode of ["401", "ratelimit"] as const) {
    for (const roomKind of REPO_ROOM_KINDS) {
      for (const principal of PRINCIPALS.filter((value) => value !== "anonymous")) {
        const row: Record<string, string> = {};
        for (const site of CALL_SITES) {
          const world = await buildWorld(roomKind, principal);
          row[site] = await withGitHub(mode, () => callSite(site, world));
        }
        table[`x:github_${mode} ${roomKind} ${principal}`] = row;
      }
    }
  }

  // Rooms bound to another host, and a bound focus room under a membership room.
  for (const mode of ["up", "503"] as const) {
    for (const roomKind of EXTRA_ROOM_KINDS) {
      for (const principal of PRINCIPALS) {
        const row: Record<string, string> = {};
        for (const site of CALL_SITES) {
          const world = await buildWorld(roomKind, principal);
          row[site] = await withGitHub(mode, () => callSite(site, world));
        }
        table[`x:${mode === "up" ? "github_up" : "outage"} ${roomKind} ${principal}`] = row;
      }
    }
  }

  // Owner token and remote MCP OAuth principals at the request gates and the live re-check.
  for (const roomKind of [...ROOM_KINDS, ...EXTRA_ROOM_KINDS]) {
    for (const kind of ["owner_token", "mcp_oauth"] as const) {
      for (const principal of ["stranger", "member", "stale_admin", "gh_admin"] as const) {
        const world = await buildWorld(roomKind, principal);
        table[`x:${kind} ${roomKind} ${principal}`] = await withGitHub("up", () => requestSites(credentialRequest(world, kind), world));
      }
    }
  }

  // A cached yes that became stale: GitHub removed the role, no webhook came.
  for (const age of ["fresh", "6min", "31min"] as const) {
    for (const roomKind of REPO_ROOM_KINDS) {
      const row: Record<string, string> = {};
      for (const site of CALL_SITES) {
        const world = await buildWorld(roomKind, "triage");
        const decision = await access!.requireGitRoomParticipant(personRequest(world), recordingResponse().res, world.project);
        assert.equal(decision, true, "the yes is cached");
        const repo = repos.get(world.repoRoomName!.split("/").at(-1)!)!;
        repo.roles.set(world.login!.toLowerCase(), "none");
        const realNow = Date.now;
        const shift = age === "6min" ? 6 * 60_000 : age === "31min" ? 31 * 60_000 : 0;
        Date.now = () => realNow() + shift;
        try {
          row[site] = await withGitHub("up", () => callSite(site, world));
        } finally {
          Date.now = realNow;
        }
      }
      table[`x:stale_yes_${age} ${roomKind} triage`] = row;
    }
  }

  // The Jev link accept route (admin only) and the room page entry.
  for (const mode of ["up", "503"] as const) {
    for (const roomKind of [...ROOM_KINDS, ...EXTRA_ROOM_KINDS]) {
      for (const principal of PRINCIPALS) {
        const jevWorld = await buildWorld(roomKind, principal);
        const entryWorld = await buildWorld(roomKind, principal);
        table[`x:${mode === "up" ? "github_up" : "outage"} ${roomKind} ${principal} pages`] = {
          jev_link: await withGitHub(mode, () => jevLinkCell(jevWorld)),
          entry_page: await withGitHub(mode, () => entryCell(entryWorld)),
        };
      }
    }
  }

  // Worker bearers at the live re-check, resolved from the database.
  for (const roomKind of [...ROOM_KINDS, ...EXTRA_ROOM_KINDS]) {
    const row: Record<string, string> = {};
    for (const scope of ["same_room", "other_room", "ended"] as const) {
      const world = await buildWorld(roomKind, "member");
      const ownerId = world.accountId!;
      const grant = (await supervisorGrantStore!.createSupervisorHostGrant({
        owner_account_id: ownerId, host_id: `host_${serial}`, installation_id: `install_${serial}`,
        allowed_room_ids: [world.project.id], allowed_agent_keys: [`owner/agent-${serial}`],
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      })).grant;
      const session = await agentSessions!.createRoomAgentSession({
        room_id: world.project.id, session_kind: "worker", runtime: "codex",
        actor_label: `W${serial} | Owner's agent | Agent`, agent_key: `owner/agent-${serial}`, agent_instance_id: `inst_${serial}`,
        display_name: `W${serial}`, owner_account_id: ownerId, owner_label: "Owner", ide_label: "Agent",
        supervisor_grant_id: grant.grant_id,
      } as never) as unknown as { session_id: string; worker_bearer: string };
      if (scope === "ended") await agentSessions!.endRoomAgentSession({ session_id: session.session_id } as never);
      const target = scope === "other_room" ? (await buildWorld("membership", "anonymous")).project : world.project;
      const req = {
        headers: { authorization: `Bearer ${session.worker_bearer}` },
        authKind: "agent_session",
        sessionAccount: null,
        agentSession: { room_id: world.project.id },
      } as unknown as AuthenticatedRequest;
      row[scope] = await withGitHub("up", () => settle(async () => String(await access!.reauthorizeGitRoomParticipant(req, target))));
    }
    table[`x:worker_live_recheck ${roomKind}`] = row;
  }

  pin(toLines(table), (key) => key.startsWith("x:"));
});

// ------------------------------------------------ gap fix A: activity stream

test("the account activity stream re-checks a repo room live and drops it after a GitHub webhook clears the cache", { skip, concurrency: false }, async () => {
  const express = (await import("express")).default;
  const { EventEmitter } = await import("node:events");
  const { AccountActivityHub } = await import("../account-activity/hub.js");
  const { registerAccountActivityStreamRoute } = await import("../routes/account/activity-stream.js");
  const { PRESENCE_CHANGED } = await import("../server/presence-change-events.js");
  const { clearGitHubRepoAccessCacheForRoom } = await import("../github/repo-access.js");

  const world = await buildWorld("repo_private", "member");
  const roomId = world.project.id;
  const repo = repos.get(roomId.split("/").at(-1)!)!;
  const working = new Map<string, string[]>();
  const presence = new EventEmitter();
  const hub = new AccountActivityHub({
    async loadWorking(roomIds) {
      const result = new Map();
      for (const id of roomIds) {
        const names = working.get(id);
        if (names?.length) result.set(id, { agents: names.map((name) => ({ agent_key: name, display_name: name })), oldestHeartbeatMs: Date.now() });
      }
      return result;
    },
    async loadLatest() { return new Map(); },
  }, { coalesceMs: 5 });
  hub.attach({ presence, messages: new EventEmitter() });
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, { authKind: "session", sessionAccount: world.sessionAccount, agentSession: null });
    next();
  });
  registerAccountActivityStreamRoute(app, { hub, getAccountRoomsForAccount: roomList!.getAccountRoomsForAccount });
  const http = app.listen(0);
  await new Promise((resolve) => http.once("listening", resolve));
  const { port } = http.address() as import("node:net").AddressInfo;
  const controller = new AbortController();
  try {
    const response = await realFetch(`http://127.0.0.1:${port}/account/activity/stream`, {
      headers: { cookie: `letagents_session=${world.sessionToken}` },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
      }
    })().catch(() => undefined);
    const until = async (condition: () => boolean, label: string) => {
      for (let i = 0; i < 120 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(condition(), label);
    };
    await until(() => text.includes("event: snapshot"), "the snapshot arrives");
    assert.ok(text.includes(roomId), "the snapshot lists the repo room");

    const before = githubCalls.length;
    working.set(roomId, ["First"]);
    presence.emit(PRESENCE_CHANGED, roomId);
    await until(() => text.includes("First"), "a frame for a readable room is sent");
    const freshCalls = githubCalls.slice(before).filter((call) => call.includes(`/repos/acme/`));
    assert.ok(freshCalls.length >= 1, "the first frame made one fresh check");

    // The person leaves the repository; GitHub's webhook clears the cache.
    repo.roles.set(world.login!.toLowerCase(), "none");
    clearGitHubRepoAccessCacheForRoom(roomId);
    working.set(roomId, ["Second"]);
    presence.emit(PRESENCE_CHANGED, roomId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!text.includes("Second"), "no frame after the webhook: the next frame re-checked and was refused");
    const afterRefusal = githubCalls.length;
    working.set(roomId, ["Third"]);
    presence.emit(PRESENCE_CHANGED, roomId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!text.includes("Third"), "the refused room stays out of the stream");
    assert.equal(githubCalls.length, afterRefusal, "a held room asks GitHub nothing more");
    controller.abort();
    await pump;
  } finally {
    controller.abort();
    hub.close();
    await new Promise((resolve) => http.close(resolve));
  }
});

// ------------------------------------------------ gap fix B: GitHub calls

test("GitHub calls per check: a fresh check asks for the repository once; a cached check reuses a yes for five minutes", { skip, concurrency: false }, async () => {
  const decisionModule = await import("../rooms/access-decision.js");
  const callsFor = (login: string) => githubCalls.filter((call) => call.startsWith(`gh-${login} `));
  const count = async (roomKind: RoomKind, principal: PrincipalKind, freshness: "fresh" | "cached") => {
    const world = await buildWorld(roomKind, principal);
    const before = callsFor(world.login!).length;
    const decision = await decisionModule.decideRoomRead({
      project: world.project,
      principal: { kind: "person", account: world.sessionAccount! },
      freshness,
    });
    return { decision: decision.kind, calls: callsFor(world.login!).length - before, world };
  };

  // A fresh check: one repository read with the person's token, plus the
  // permission read when they do not own a private repository.
  assert.deepEqual(
    (({ decision, calls }) => ({ decision, calls }))(await count("repo_private", "member", "fresh")),
    { decision: "allow", calls: 2 },
  );
  assert.deepEqual(
    (({ decision, calls }) => ({ decision, calls }))(await count("repo_public", "triage", "fresh")),
    { decision: "allow", calls: 1 },
  );
  assert.deepEqual(
    (({ decision, calls }) => ({ decision, calls }))(await count("repo_private", "stranger", "fresh")),
    { decision: "repo_access_denied", calls: 1 },
  );

  // A cached yes is reused, and kept no longer than five minutes.
  const { world } = await count("repo_private", "member", "cached");
  const again = callsFor(world.login!).length;
  const reread = await decisionModule.decideRoomRead({ project: world.project, principal: { kind: "person", account: world.sessionAccount! } });
  assert.equal(reread.kind, "allow");
  assert.equal(callsFor(world.login!).filter((call) => call.includes("/permission")).length, 1, "the yes is reused");
  assert.ok(callsFor(world.login!).length - again <= 1, "at most the shared visibility read");
  const repoAccess = await import("../github/repo-access.js");
  assert.equal(repoAccess.REPO_ACCESS_TTL_MS, 5 * 60 * 1000);
});

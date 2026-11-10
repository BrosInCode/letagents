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

const FIXTURE = path.resolve(process.cwd(), "src/api/__tests__/fixtures/room-access-characterization.json");

// ---------------------------------------------------------------- fake GitHub

type GitHubRole = "none" | "read" | "triage" | "admin";
const repos = new Map<string, { private: boolean; roles: Map<string, GitHubRole> }>();
let githubDown = false;
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

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const token = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
  githubCalls.push(`${token || "anon"} ${url.pathname}`);
  if (githubDown) return json(503, { message: "unavailable" });
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

async function buildWorld(roomKind: RoomKind, principal: PrincipalKind): Promise<World> {
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
  }
  const project = (await roomsDb!.getProjectById(roomId))!;
  assert.ok(project, `room ${roomId} exists`);
  const roles = new Map<string, GitHubRole>();
  const repoRoomName = repoName ? `github.com/acme/${repoName}` : null;
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
  return { project, accessRoomId, repoRoomName, login, accountId: account.id, sessionToken, sessionAccount };
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
  if (process.env.UPDATE_ROOM_ACCESS_CHARACTERIZATION === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(lines, null, 1)}\n`);
    return;
  }
  const pinned = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(lines), Object.keys(pinned), "the same table rows");
  for (const key of Object.keys(pinned)) {
    assert.equal(lines[key], pinned[key], `answers changed for ${key}`);
  }
});

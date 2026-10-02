import assert from "node:assert/strict";
import test from "node:test";

import {
  registerRoomPullRequestDiffRoutes,
  __resetPullRequestDiffCache,
  type RoomPullRequestDiffRouteDeps,
} from "../routes/rooms/pull-request-diff.js";

type Handler = (req: Record<string, unknown>, res: ReturnType<typeof responseStub>) => Promise<void>;

function responseStub() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

const ROOM = "github.com/octo/repo";
const REPO = {
  installation_id: "inst_1",
  owner_login: "octo",
  repo_name: "repo",
  full_name: "octo/repo",
  host: "github.com",
  removed_at: null as string | null,
};

function baseDeps(overrides: Partial<RoomPullRequestDiffRouteDeps> = {}): {
  deps: RoomPullRequestDiffRouteDeps;
  calls: { fetches: number; participant: number; freshChecks: number };
  state: { eventSha: string; fetchedSha: string };
} {
  const calls = { fetches: 0, participant: 0, freshChecks: 0 };
  const state = { eventSha: "sha_abc", fetchedSha: "sha_abc" };
  const deps: RoomPullRequestDiffRouteDeps = {
    resolveCanonicalRoomRequestId: async (id) => id,
    resolveRoomOrReply: async () => ({ id: ROOM, parent_room_id: null }) as never,
    requireParticipant: async (_req, _res, _project, options) => {
      calls.participant += 1;
      if (options?.freshCollaboratorCheck) calls.freshChecks += 1;
      return true;
    },
    getGitHubAppRepositoryByRoomId: async () => REPO,
    getGitHubAppInstallationById: async () => ({ suspended_at: null, uninstalled_at: null }),
    getGitHubRoomEvents: async () => ({ events: [{ head_sha: state.eventSha }] }),
    fetchPullRequestUnifiedDiff: async () => {
      calls.fetches += 1;
      return { diff: "diff --git a b", headSha: state.fetchedSha };
    },
    ...overrides,
  };
  return { deps, calls, state };
}

function handlerFor(deps: RoomPullRequestDiffRouteDeps): Handler {
  let handler: Handler | null = null;
  const app = { get: (_re: RegExp, h: Handler) => { handler = h; } } as unknown as Parameters<
    typeof registerRoomPullRequestDiffRoutes
  >[0];
  registerRoomPullRequestDiffRoutes(app, deps);
  if (!handler) throw new Error("route not registered");
  return handler;
}

function req(roomRaw: string, number: string) {
  return { params: { 0: roomRaw, 1: number } };
}

test("gate runs first (with fresh collaborator check) and denies before repo/fetch", async () => {
  __resetPullRequestDiffCache();
  let repoLookups = 0;
  const { deps, calls } = baseDeps({
    requireParticipant: async (_req, res) => {
      (res as ReturnType<typeof responseStub>).status(403).json({ error: "PRIVATE_REPO_NO_ACCESS" });
      return false;
    },
    getGitHubAppRepositoryByRoomId: async () => {
      repoLookups += 1;
      return REPO;
    },
  });
  const res = responseStub();
  await handlerFor(deps)(req(ROOM, "42"), res);
  assert.equal(res.statusCode, 403);
  assert.equal(repoLookups, 0, "no repo lookup after gate denial");
  assert.equal(calls.fetches, 0, "no diff fetch after gate denial");
});

test("requests a fresh (cache-bypassing) collaborator check", async () => {
  __resetPullRequestDiffCache();
  const { deps, calls } = baseDeps();
  await handlerFor(deps)(req(ROOM, "42"), responseStub());
  assert.equal(calls.freshChecks, 1, "gate invoked with freshCollaboratorCheck");
});

test("returns the diff for an authorized participant with a room-associated PR", async () => {
  __resetPullRequestDiffCache();
  const { deps, calls } = baseDeps();
  const res = responseStub();
  await handlerFor(deps)(req(ROOM, "42"), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { number: 42, head_sha: "sha_abc", diff: "diff --git a b", cached: false });
  assert.equal(calls.fetches, 1);
});

test("focus rooms resolve the repository and events via the parent git-room", async () => {
  __resetPullRequestDiffCache();
  let lookupRoomId = "";
  const { deps } = baseDeps({
    resolveRoomOrReply: async () => ({ id: "focus_27", parent_room_id: ROOM }) as never,
    getGitHubAppRepositoryByRoomId: async (roomId) => {
      lookupRoomId = roomId;
      return REPO;
    },
    getGitHubRoomEvents: async (input) => {
      assert.equal(input.room_id, ROOM, "events queried on the parent repo room");
      return { events: [{ head_sha: "sha_abc" }] };
    },
  });
  const res = responseStub();
  await handlerFor(deps)(req("focus_27", "42"), res);
  assert.equal(lookupRoomId, ROOM);
  assert.equal(res.statusCode, 200);
});

test("409 when the App installation is suspended, 409 when the repo is removed", async () => {
  __resetPullRequestDiffCache();
  const suspended = baseDeps({ getGitHubAppInstallationById: async () => ({ suspended_at: "2026-07-01T00:00:00Z" }) });
  const r1 = responseStub();
  await handlerFor(suspended.deps)(req(ROOM, "42"), r1);
  assert.equal(r1.statusCode, 409);
  assert.equal(suspended.calls.fetches, 0);

  __resetPullRequestDiffCache();
  const removed = baseDeps({ getGitHubAppRepositoryByRoomId: async () => ({ ...REPO, removed_at: "2026-07-01T00:00:00Z" }) });
  const r2 = responseStub();
  await handlerFor(removed.deps)(req(ROOM, "42"), r2);
  assert.equal(r2.statusCode, 409, "removed repo rejected before token minting");
  assert.equal(removed.calls.fetches, 0);
});

test("404 when the PR number is not associated with the room (no arbitrary proxying)", async () => {
  __resetPullRequestDiffCache();
  const { deps, calls } = baseDeps({ getGitHubRoomEvents: async () => ({ events: [] }) });
  const res = responseStub();
  await handlerFor(deps)(req(ROOM, "999"), res);
  assert.equal(res.statusCode, 404);
  assert.equal(calls.fetches, 0);
});

test("caches by head SHA (same SHA served from cache; a force-push refetches)", async () => {
  __resetPullRequestDiffCache();
  const { deps, calls, state } = baseDeps();
  const handler = handlerFor(deps);

  await handler(req(ROOM, "42"), responseStub());
  assert.equal(calls.fetches, 1);

  const second = responseStub();
  await handler(req(ROOM, "42"), second);
  assert.equal((second.body as { cached: boolean }).cached, true, "served from cache");
  assert.equal(calls.fetches, 1);

  state.eventSha = "sha_def";
  state.fetchedSha = "sha_def"; // force-push: room event + GitHub agree on the new SHA
  const third = responseStub();
  await handler(req(ROOM, "42"), third);
  assert.equal(calls.fetches, 2, "new head SHA misses the cache");
  assert.equal((third.body as { head_sha: string }).head_sha, "sha_def");
});

test("409 without caching when the fetched head SHA disagrees with the room event", async () => {
  __resetPullRequestDiffCache();
  const { deps, calls, state } = baseDeps();
  state.eventSha = "sha_event";
  state.fetchedSha = "sha_other"; // GitHub says a different head than the room event
  const handler = handlerFor(deps);
  const res = responseStub();
  await handler(req(ROOM, "42"), res);
  assert.equal(res.statusCode, 409);
  assert.equal((res.body as { code: string }).code, "sha_mismatch");
  // Not cached → a retry refetches.
  const res2 = responseStub();
  await handler(req(ROOM, "42"), res2);
  assert.equal(calls.fetches, 2);
});

test("coalesces concurrent misses into a single fetch and one cache entry (single-flight)", async () => {
  __resetPullRequestDiffCache();
  const { deps, calls } = baseDeps({
    fetchPullRequestUnifiedDiff: async () => {
      calls.fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { diff: "d", headSha: "sha_abc" };
    },
  });
  const handler = handlerFor(deps);
  const a = responseStub();
  const b = responseStub();
  // Both start before the first fetch resolves, so the second must coalesce.
  await Promise.all([handler(req(ROOM, "42"), a), handler(req(ROOM, "42"), b)]);
  assert.equal(calls.fetches, 1, "both concurrent misses share one fetch");
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  // A follow-up is served from cache → the producer wrote exactly one entry.
  const c = responseStub();
  await handler(req(ROOM, "42"), c);
  assert.equal((c.body as { cached: boolean }).cached, true);
  assert.equal(calls.fetches, 1, "no refetch; single cached entry");
});

test("maps upstream error codes and never caches errors", async () => {
  const cases: Array<[string, number]> = [
    ["not_found", 404],
    ["forbidden", 403],
    ["rate_limited", 429],
    ["too_large", 413],
    ["timeout", 504],
    ["moved", 409],
    ["invalid_content", 502],
  ];
  for (const [code, status] of cases) {
    __resetPullRequestDiffCache();
    const { deps, calls } = baseDeps({
      fetchPullRequestUnifiedDiff: async () => {
        calls.fetches += 1;
        throw Object.assign(new Error(code), { code });
      },
    });
    const handler = handlerFor(deps);
    const res = responseStub();
    await handler(req(ROOM, "42"), res);
    assert.equal(res.statusCode, status, `code ${code} → ${status}`);
    // A subsequent request must refetch (the error was not cached).
    const res2 = responseStub();
    await handler(req(ROOM, "42"), res2);
    assert.equal(calls.fetches, 2, `error for ${code} not cached`);
  }
});

test("400 on a non-numeric pull request number", async () => {
  __resetPullRequestDiffCache();
  const { deps, calls } = baseDeps();
  const res = responseStub();
  await handlerFor(deps)(req(ROOM, "0"), res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.participant, 0);
});

const fileList = { files: [{ path: "a.ts", previous_path: null, status: "added", additions: 1, deletions: 0 }], total_files: 101 };
test("desktop metadata is opt-in; default and cached agent responses retain their exact shape", async () => {
  __resetPullRequestDiffCache();
  const inputs: unknown[] = [];
  const { deps } = baseDeps({ fetchPullRequestUnifiedDiff: async (input) => {
    inputs.push(input);
    return { diff: "patch", headSha: "sha_abc", fileList };
  } });
  const handler = handlerFor(deps);
  const response = responseStub();
  await handler({ ...req(ROOM, "42"), query: { include_files: "1", owner: "attacker", repo: "other", url: "http://127.0.0.1/" } }, response);
  assert.deepEqual(inputs, [{ owner: "octo", repo: "repo", number: 42, installationId: "inst_1", includeFiles: true }]);
  assert.deepEqual(response.body, { number: 42, head_sha: "sha_abc", diff: "patch", cached: false, file_list: fileList, github_url: "https://github.com/octo/repo/pull/42/files" });
  const desktopCached = responseStub();
  await handler({ ...req(ROOM, "42"), query: { include_files: "1" } }, desktopCached);
  assert.equal((desktopCached.body as { cached: boolean }).cached, true);
  const legacy = responseStub();
  await handler(req(ROOM, "42"), legacy);
  assert.deepEqual(legacy.body, { number: 42, head_sha: "sha_abc", diff: "patch", cached: true });
  assert.equal(inputs.length, 1);
});

test("an unavailable file list is cached explicitly so repeated desktop reads do not refetch", async () => {
  __resetPullRequestDiffCache();
  let calls = 0;
  const { deps } = baseDeps({ fetchPullRequestUnifiedDiff: async () => {
    calls++;
    return { diff: "patch", headSha: "sha_abc", fileList: null };
  } });
  const handler = handlerFor(deps);
  const request = { ...req(ROOM, "42"), query: { include_files: "1" } };
  const first = responseStub();
  await handler(request, first);
  assert.equal(first.statusCode, 200);
  assert.equal((first.body as { file_list: unknown }).file_list, null);
  const second = responseStub();
  await handler(request, second);
  assert.deepEqual(second.body, { number: 42, head_sha: "sha_abc", diff: "patch", cached: true, file_list: null, github_url: "https://github.com/octo/repo/pull/42/files" });
  assert.equal(calls, 1, "retry serves the unavailable marker without another GitHub fetch");
  const legacy = responseStub();
  await handler(req(ROOM, "42"), legacy);
  assert.deepEqual(legacy.body, { number: 42, head_sha: "sha_abc", diff: "patch", cached: true });
});

test("a plain in-flight fetch finishing after a desktop fetch preserves its file list", async () => {
  for (const metadata of [fileList, null]) {
    __resetPullRequestDiffCache();
    let releasePlain!: () => void;
    let plainStarted!: () => void;
    const started = new Promise<void>(resolve => { plainStarted = resolve; });
    const release = new Promise<void>(resolve => { releasePlain = resolve; });
    let fetches = 0;
    const { deps } = baseDeps({ fetchPullRequestUnifiedDiff: async input => {
      fetches++;
      if (input.includeFiles) return { diff: "patch", headSha: "sha_abc", fileList: metadata };
      plainStarted();
      await release;
      return { diff: "patch", headSha: "sha_abc" };
    } });
    const handler = handlerFor(deps);
    const plain = handler(req(ROOM, "42"), responseStub());
    await started;
    const request = { ...req(ROOM, "42"), query: { include_files: "1" } };
    await handler(request, responseStub());
    releasePlain();
    await plain;
    const cached = responseStub();
    await handler(request, cached);
    assert.deepEqual(cached.body, { number: 42, head_sha: "sha_abc", diff: "patch", cached: true, file_list: metadata, github_url: "https://github.com/octo/repo/pull/42/files" });
    assert.equal(fetches, 2, "the plain completion must not force a third fetch");
  }
});

test("a plain cached diff can still be enhanced once", async () => {
  __resetPullRequestDiffCache();
  const inputs: Array<boolean | undefined> = [];
  const { deps } = baseDeps({ fetchPullRequestUnifiedDiff: async input => {
    inputs.push(input.includeFiles);
    return { diff: "patch", headSha: "sha_abc", ...(input.includeFiles ? { fileList } : {}) };
  } });
  const handler = handlerFor(deps);
  await handler(req(ROOM, "42"), responseStub());
  const request = { ...req(ROOM, "42"), query: { include_files: "1" } };
  await handler(request, responseStub());
  const cached = responseStub();
  await handler(request, cached);
  assert.deepEqual(inputs, [undefined, true]);
  assert.deepEqual((cached.body as { file_list: unknown }).file_list, fileList);
  assert.equal((cached.body as { cached: boolean }).cached, true);
});

test("revoked access cannot read cached desktop file metadata", async () => {
  __resetPullRequestDiffCache();
  let allowed = true;
  const { deps } = baseDeps({
    fetchPullRequestUnifiedDiff: async () => ({ diff: "private", headSha: "sha_abc", fileList }),
    requireParticipant: async (_req, res) => {
      if (!allowed) res.status(403).json({ error: "PRIVATE_REPO_NO_ACCESS" });
      return allowed;
    },
  });
  const handler = handlerFor(deps), request = { ...req(ROOM, "42"), query: { include_files: "1" } };
  await handler(request, responseStub());
  allowed = false;
  const denied = responseStub();
  await handler(request, denied);
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(denied.body, { error: "PRIVATE_REPO_NO_ACCESS" });
});

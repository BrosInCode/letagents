import assert from "node:assert/strict";
import test from "node:test";

class ApiError extends Error {
  constructor(readonly status: number, readonly payload: { code?: string }) { super("private upstream details"); }
}
async function load(t: test.TestContext, options: { local?: boolean; error?: Error } = {}) {
  const paths: string[] = [];
  t.mock.module("../main/auth.js", { namedExports: {
    DesktopApiError: ApiError,
    apiFetch: async (path: string) => {
      paths.push(path);
      if (options.error) throw options.error;
      return { number: 42, head_sha: "s1", diff: "patch", file_list: null, github_url: "https://github.com/org/repo/pull/42/files" };
    },
  } });
  t.mock.module("../main/rooms/local-store.js", { namedExports: {
    resolveLocalAwareRoomStorageMode: async () => ({ effectiveMode: options.local ? "local" : "cloud" }),
    cloudRoomIdentifierForStorage: () => "github.com/org/repo",
  } });
  const subject = await import(new URL(`../main/rooms/pull-request-diff.js?${t.name}`, import.meta.url).href) as typeof import("../main/rooms/pull-request-diff.js");
  return { subject, paths };
}
test("the viewer requests only the resolved room and PR number, with file metadata opt-in", async t => {
  const { subject, paths } = await load(t);
  assert.equal((await subject.getDesktopPullRequestDiff("local-alias", 42)).ok, true);
  assert.deepEqual(paths, ["/rooms/github.com%2Forg%2Frepo/pull-requests/42/diff?include_files=1"]);
});
test("bad numbers and local-only rooms do not make HTTP requests", async t => {
  const { subject, paths } = await load(t, { local: true });
  for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(await subject.getDesktopPullRequestDiff("room", number), { ok: false, code: "invalid_request" });
  }
  assert.deepEqual(await subject.getDesktopPullRequestDiff("room", 42), { ok: false, code: "not_connected" });
  assert.deepEqual(paths, []);
});
test("structured failures survive IPC without disclosing server text", async t => {
  const { subject } = await load(t, { error: new ApiError(429, { code: "rate_limited" }) });
  assert.deepEqual(await subject.getDesktopPullRequestDiff("room", 42), { ok: false, code: "rate_limited" });
});
test("a revoked participant gate maps to the permission notice", async t => {
  const { subject } = await load(t, { error: new ApiError(403, {}) });
  assert.deepEqual(await subject.getDesktopPullRequestDiff("room", 42), { ok: false, code: "forbidden" });
});

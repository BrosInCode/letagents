import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPullRequestDiffModel, createPullRequestDiffSession, pullRequestReference, pullRequestDiffNotice,
  PR_PATCH_LIMIT, type PullRequestDiffState,
} from "../src/domain/pull-request-diff";
import type { DesktopPullRequestDiff, DesktopPullRequestDiffResult } from "../../electron/ipc-types/room";

const file = (path: string, status = "modified", additions = 1, deletions = 1) => ({ path, previous_path: null, status, additions, deletions });
const payload = (diff: string, files: NonNullable<DesktopPullRequestDiff["file_list"]>["files"] | null = [file("a.ts")]): DesktopPullRequestDiff => ({
  number: 42, head_sha: "abc", diff, github_url: "https://github.com/org/repo/pull/42/files",
  file_list: files ? { files, total_files: files.length } : null,
});
const patch = (path: string, text = "<script>alert(1)</script>") =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -4 +4 @@\n-old\n+${text}\n`;

test("View changes is limited to positive PR references in the connected GitHub repository", () => {
  assert.deepEqual(pullRequestReference("https://github.com/ORG/repo/pull/42#discussion", "github.com/org/repo"), { number: 42, url: "https://github.com/org/repo/pull/42/files" });
  for (const url of ["https://github.com/other/repo/pull/42", "https://github.com/org/repo/issues/42", "http://github.com/org/repo/pull/42", "https://github.com.evil/org/repo/pull/42", "https://user@github.com/org/repo/pull/42", "https://github.com/org/repo/pull/0", "https://github.com/org/repo/pull/9007199254740992", "javascript:alert(1)"]) {
    assert.equal(pullRequestReference(url, "org/repo"), null, url);
  }
  assert.equal(pullRequestReference("https://github.com/org/repo/pull/42", null), null);
});

test("the existing page reader receives only the selected file and preserves code as text", async () => {
  const model = await buildPullRequestDiffModel(payload(patch("a.ts") + patch("b.ts", "second"), [file("a.ts"), file("b.ts")]));
  assert.equal(model.snapshot.patch, "", "raw PR diff is not indexed by WorkspaceDiff");
  assert.deepEqual(model.snapshot.files.map(f => [f.path, f.additions, f.deletions]), [["a.ts", 1, 1], ["b.ts", 1, 1]]);
  const page = await model.loadPage("a.ts", {});
  assert.deepEqual(page.lines.map(line => line.text), ["@@ -4 +4 @@", "old", "<script>alert(1)</script>"]);
  assert.equal(page.lines[2].after, 4);
  assert.equal((await model.loadPage("b.ts", {})).lines[2].text, "second");
  assert.equal((await model.loadPage("unknown", {})).included, false);
});

test("renames, binary files and omitted patches remain distinct from empty changes", async () => {
  const diff = 'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n'
    + "diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n"
    + "diff --git a/no-hunk.ts b/no-hunk.ts\nindex abc..def 100644\n";
  const model = await buildPullRequestDiffModel(payload(diff, [
    { ...file("new.ts", "renamed", 0, 0), previous_path: "old.ts" },
    file("image.png", "modified", 0, 0), file("missing.ts"), file("no-hunk.ts"),
  ]));
  assert.equal(model.snapshot.files[0].previous_path, "old.ts");
  assert.equal((await model.loadPage("new.ts", {})).included, true);
  assert.equal(model.notices["image.png"].title, "Binary file changed");
  assert.equal(model.notices["missing.ts"].title, "Patch unavailable");
  await model.loadPage("no-hunk.ts", {});
  assert.equal(model.notices["no-hunk.ts"].title, "Patch unavailable");
});

test("a failed file list falls back to diff paths including quoted UTF-8 paths and removals", async () => {
  const diff = 'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\nnew file mode 100644\n--- /dev/null\n+++ "b/caf\\303\\251.ts"\n@@ -0,0 +1 @@\n+hello\n'
    + "diff --git a/gone file.ts b/gone file.ts\ndeleted file mode 100644\n--- a/gone file.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n";
  const model = await buildPullRequestDiffModel(payload(diff, null));
  assert.equal(model.fileListUnavailable, true);
  assert.deepEqual(model.snapshot.files.map(f => [f.path, f.status]), [["café.ts", "added"], ["gone file.ts", "deleted"]]);
  assert.equal((await model.loadPage("café.ts", {})).lines[1].text, "hello");
});

test("Git-generated space-path headers retain their patches with and without file metadata", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pr-diff-space-paths-"));
  const files = [file("has space.ts"), file(" has edge spaces.ts "), file("gone file.ts", "removed", 0, 1)];
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    git("init", "--quiet");
    for (const { path } of files) writeFileSync(join(cwd, path), "old\n");
    git("add", "--all");
    writeFileSync(join(cwd, files[0].path), "new\n");
    writeFileSync(join(cwd, files[1].path), "new\n");
    unlinkSync(join(cwd, files[2].path));
    const diff = git("diff", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/");
    assert.ok(diff.includes("+++ b/has space.ts\t\n"), "fixture includes Git's actual tab delimiter");
    assert.ok(diff.includes("--- a/gone file.ts\t\n"), "removed paths use the source header");
    for (const metadata of [files, null]) {
      const model = await buildPullRequestDiffModel(payload(diff, metadata));
      assert.deepEqual(model.snapshot.files.map(f => f.path).sort(), files.map(f => f.path).sort());
      for (const { path, status } of files) {
        assert.equal(model.notices[path], undefined);
        const page = await model.loadPage(path, {});
        assert.equal(page.included, true, path);
        assert.deepEqual(page.lines.filter(line => line.kind !== "hunk").map(line => line.text),
          status === "removed" ? ["old"] : ["old", "new"]);
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("5 MiB input is bounded to 100 files, yields while scanning, and never parses giant selected patches", async () => {
  const diffs = Array.from({ length: 120 }, (_, n) => patch(`file${n}.ts`, "x".repeat(40000)));
  const value = payload(diffs.join(""), null);
  assert.ok(value.diff.length < 5 * 1024 * 1024);
  let yields = 0;
  const model = await buildPullRequestDiffModel(value, () => true, async () => { yields++; });
  assert.equal(model.snapshot.files.length, 100);
  assert.equal(model.snapshot.hidden_files, 20);
  assert.equal(yields, 3);
  const big = await buildPullRequestDiffModel(payload(patch("a.ts", "x".repeat(PR_PATCH_LIMIT))));
  assert.equal((await big.loadPage("a.ts", {})).lines.length, 0);
  assert.equal(big.notices["a.ts"].title, "Too large to show here");
  const unicode = await buildPullRequestDiffModel(payload(patch("a.ts", "😀".repeat(40000))));
  assert.equal((await unicode.loadPage("a.ts", {})).lines.length, 0);
  assert.equal(unicode.notices["a.ts"].title, "Too large to show here", "cap is UTF-8 bytes");
});

test("selected text is paged by the existing 500-line budget", async () => {
  const value = payload("diff --git a/a.ts b/a.ts\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,900 @@\n" + "+line\n".repeat(900));
  const model = await buildPullRequestDiffModel(value);
  const first = await model.loadPage("a.ts", {});
  assert.equal(first.lines.length, 500);
  const second = await model.loadPage("a.ts", { offset: first.nextOffset! });
  assert.equal(second.lines[0].after, 500);
  assert.equal(second.lines.at(-1)?.after, 900);
});

test("closing or changing the room discards pending results and loading state", async () => {
  const requests: Array<(result: DesktopPullRequestDiffResult) => void> = [];
  let state: PullRequestDiffState = { loading: false, model: null, error: null, headSha: null };
  const session = createPullRequestDiffSession(() => new Promise(resolve => requests.push(resolve)), next => { state = next; });
  const first = session.load("room-a", 1);
  session.close();
  requests[0]({ ok: true, value: payload(patch("a.ts")) });
  await first;
  assert.equal(state.model, null);
  assert.equal(state.loading, false);
  const second = session.load("room-a", 1), third = session.load("room-b", 2);
  requests[2]({ ok: false, code: "forbidden" });
  await third;
  requests[1]({ ok: true, value: payload(patch("a.ts")) });
  await second;
  assert.equal(state.model, null);
  assert.match(state.error!, /no longer have access/);
});

test("known upstream errors produce distinct plain notices and unknown errors never leak", () => {
  const codes = ["not_connected", "installation_inactive", "forbidden", "rate_limited", "not_found", "too_large", "timeout"];
  assert.equal(new Set(codes.map(pullRequestDiffNotice)).size, codes.length);
  assert.doesNotMatch(pullRequestDiffNotice("secret stack trace"), /secret/);
});

test("both PR entry points reuse the viewer and the existing focus-managed dialog and diff surface", () => {
  const root = "../src/components/desktop/content/";
  for (const path of ["RoomEventsView.vue", "desktop-chat-message/DesktopGitHubEventCard.vue"]) {
    assert.match(readFileSync(new URL(root + path, import.meta.url), "utf8"), /<PullRequestChangesButton/);
  }
  const dialog = readFileSync(new URL(root + "room-events/PullRequestChangesDialog.vue", import.meta.url), "utf8");
  assert.match(dialog, /<DesktopDialogShell/);
  assert.match(dialog, /initial-focus="\.pr-changes-close"/);
  assert.match(dialog, /<WorkspaceDiff/);
  assert.doesNotMatch(dialog, /v-html/);
});

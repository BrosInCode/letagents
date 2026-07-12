import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  DesktopRoomSharedArtifactChangedFile,
  DesktopRoomSharedArtifact,
} from "../../electron/ipc-types";
import {
  changeSummaryHeadline,
  retainExpandableChangeArtifacts,
  roomArtifactTimelineItems,
  splitChangeSummaryFiles,
} from "../src/domain/room-artifacts";

function changeArtifact(identityKey: string, fileCount: number | null): DesktopRoomSharedArtifact {
  const detail =
    fileCount === null
      ? null
      : {
          type: "change_summary" as const,
          version: 1 as const,
          changedFileCount: fileCount,
          additions: fileCount,
          deletions: 0,
          stagedFileCount: 0,
          unstagedFileCount: fileCount,
          untrackedFileCount: 0,
          hiddenFileCount: 0,
          files: Array.from({ length: fileCount }, (_value, index) => changedFile(`src/f${index}.ts`)),
        };
  return { identityKey, kind: "change_summary", detail } as unknown as DesktopRoomSharedArtifact;
}

test("retainExpandableChangeArtifacts keeps a row collapsed across dirty -> clean -> dirty", () => {
  const key = "git:change_summary:id:managed-agent:key:emmy/x:branch:feature/y";

  // Expanded on a dirty (>3-file) artifact: retained.
  let state = retainExpandableChangeArtifacts(new Set([key]), [changeArtifact(key, 5)]);
  assert.deepEqual([...state], [key]);

  // Chain the returned state: goes clean -> pruned.
  state = retainExpandableChangeArtifacts(state, [changeArtifact(key, null)]);
  assert.deepEqual([...state], []);

  // Returns dirty (>3): must NOT silently reopen expanded.
  state = retainExpandableChangeArtifacts(state, [changeArtifact(key, 5)]);
  assert.deepEqual([...state], []);
});

function changedFile(path: string): DesktopRoomSharedArtifactChangedFile {
  return {
    path,
    previousPath: null,
    status: "modified",
    additions: 1,
    deletions: 0,
    binary: false,
    staged: false,
    unstaged: true,
    untracked: false,
  };
}

test("changeSummaryHeadline formats file count with additions and deletions", () => {
  assert.equal(
    changeSummaryHeadline({
      type: "change_summary",
      version: 1,
      changedFileCount: 3,
      additions: 10,
      deletions: 2,
      stagedFileCount: 0,
      unstagedFileCount: 3,
      untrackedFileCount: 0,
      hiddenFileCount: 0,
      files: [],
    }),
    "3 files  +10  −2",
  );
  assert.equal(
    changeSummaryHeadline({
      type: "change_summary",
      version: 1,
      changedFileCount: 1,
      additions: 0,
      deletions: 0,
      stagedFileCount: 0,
      unstagedFileCount: 1,
      untrackedFileCount: 0,
      hiddenFileCount: 0,
      files: [],
    }),
    "1 file",
  );
});

test("splitChangeSummaryFiles collapses to the limit and reports hidden count", () => {
  const files = Array.from({ length: 5 }, (_value, index) => changedFile(`src/f${index}.ts`));
  const collapsed = splitChangeSummaryFiles(files, false);
  assert.equal(collapsed.visible.length, 3);
  assert.equal(collapsed.hiddenCount, 2);
  const expanded = splitChangeSummaryFiles(files, true);
  assert.equal(expanded.visible.length, 5);
  assert.equal(expanded.hiddenCount, 0);
});

test("roomArtifactTimelineItems orders artifacts by latest activity and labels metadata", () => {
  const artifacts = [
    artifact({
      identityKey: "git:branch:ref:feature/local",
      kind: "branch",
      provider: "git",
      ref: "feature/local",
      source: "manual",
      firstSeenAt: "2026-06-17T10:00:00.000Z",
      updatedAt: "2026-06-17T10:05:00.000Z",
      linkedTaskIds: ["task_1", "task_2"],
    }),
    artifact({
      identityKey: "github:check_run:number:42",
      kind: "check_run",
      provider: "github",
      artifactNumber: 42,
      title: "integration-tests",
      source: "github_event",
      state: "failure",
      firstSeenAt: "2026-06-17T10:02:00.000Z",
      updatedAt: "2026-06-17T10:08:00.000Z",
      linkedTaskIds: ["task_3"],
    }),
  ];
  const items = roomArtifactTimelineItems(artifacts);

  assert.deepEqual(items.map((item) => item.artifact.identityKey), [
    "github:check_run:number:42",
    "git:branch:ref:feature/local",
  ]);
  assert.equal(items[0]?.kindLabel, "Check");
  assert.equal(items[0]?.metaLabel, "GitHub event · failure · #42");
  assert.equal(items[0]?.taskCountLabel, "1 linked task");
  assert.equal(items[1]?.title, "feature/local");
  assert.equal(items[1]?.metaLabel, "Manual Git artifact · ref feature/local");
  assert.equal(items[1]?.taskCountLabel, "2 linked tasks");
  assert.equal(items[1]?.wasUpdated, true);

  assert.deepEqual(
    roomArtifactTimelineItems(artifacts, { taskId: "task_2" }).map((item) => item.artifact.identityKey),
    ["git:branch:ref:feature/local"],
  );
  assert.deepEqual(
    roomArtifactTimelineItems(artifacts, { taskId: "missing_task" }),
    [],
  );
});

function artifact(
  input: Partial<DesktopRoomSharedArtifact> & Pick<DesktopRoomSharedArtifact, "identityKey" | "kind">,
): DesktopRoomSharedArtifact {
  return {
    roomId: "room_1",
    provider: "git",
    artifactId: null,
    artifactNumber: null,
    title: null,
    url: null,
    ref: null,
    state: null,
    source: "manual",
    firstSeenAt: "2026-06-17T10:00:00.000Z",
    updatedAt: "2026-06-17T10:00:00.000Z",
    linkedTaskIds: [],
    ...input,
  };
}

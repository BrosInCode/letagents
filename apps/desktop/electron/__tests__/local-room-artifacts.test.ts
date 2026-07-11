import assert from "node:assert/strict";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({
  prefix: "letagents-desktop-local-artifacts-",
  paths: ["chatStorage", "localChatDb", "localProfile"],
});

const { publishLocalRoomWorkflowArtifact, getLocalRoomArtifacts } = await import(
  "../main/rooms/artifacts/local-store.js"
);

test("local workflow artifacts round-trip change_summary file detail", async () => {
  const roomId = "local:room-detail";
  await publishLocalRoomWorkflowArtifact({
    roomId,
    artifact: {
      provider: "git",
      kind: "change_summary",
      id: "managed-agent:key:emmy/x:branch:feature/y",
      ref: "feature/y",
      state: "updated",
      title: "worktree on feature/y (1 file changed)",
      detail: {
        type: "change_summary",
        version: 1,
        changedFileCount: 1,
        additions: 4,
        deletions: 1,
        stagedFileCount: 1,
        unstagedFileCount: 0,
        untrackedFileCount: 0,
        hiddenFileCount: 0,
        files: [
          {
            path: "src/a.ts",
            previousPath: null,
            status: "modified",
            additions: 4,
            deletions: 1,
            binary: false,
            staged: true,
            unstaged: false,
            untracked: false,
          },
        ],
      },
    },
  });

  const { artifacts } = await getLocalRoomArtifacts(roomId);
  assert.equal(artifacts?.length, 1);
  const detail = artifacts?.[0]?.detail;
  assert.ok(detail);
  assert.equal(detail?.type, "change_summary");
  assert.equal(detail?.changedFileCount, 1);
  assert.equal(detail?.files.length, 1);
  assert.equal(detail?.files[0]?.path, "src/a.ts");
  assert.equal(detail?.files[0]?.additions, 4);
  assert.equal(detail?.files[0]?.deletions, 1);
});

test("local workflow artifacts persist with null detail when none is supplied", async () => {
  const roomId = "local:room-nodetail";
  await publishLocalRoomWorkflowArtifact({
    roomId,
    artifact: {
      provider: "github",
      kind: "pull_request",
      url: "https://github.com/x/y/pull/2",
    },
  });

  const { artifacts } = await getLocalRoomArtifacts(roomId);
  assert.equal(artifacts?.length, 1);
  assert.equal(artifacts?.[0]?.detail, null);
});

test("a clean update clears previously published change_summary detail", async () => {
  const roomId = "local:room-transition";
  const identity = {
    provider: "git",
    kind: "change_summary",
    id: "managed-agent:key:emmy/x:branch:feature/z",
    ref: "feature/z",
  };

  await publishLocalRoomWorkflowArtifact({
    roomId,
    artifact: {
      ...identity,
      state: "updated",
      detail: {
        type: "change_summary",
        version: 1,
        changedFileCount: 1,
        additions: 1,
        deletions: 0,
        stagedFileCount: 0,
        unstagedFileCount: 1,
        untrackedFileCount: 0,
        hiddenFileCount: 0,
        files: [
          {
            path: "src/a.ts",
            previousPath: null,
            status: "modified",
            additions: 1,
            deletions: 0,
            binary: false,
            staged: false,
            unstaged: true,
            untracked: false,
          },
        ],
      },
    },
  });

  // Re-publish the same artifact as a clean worktree (no detail): the prior file
  // list must be cleared, not retained under state=clean.
  await publishLocalRoomWorkflowArtifact({
    roomId,
    artifact: { ...identity, state: "clean" },
  });

  const { artifacts } = await getLocalRoomArtifacts(roomId);
  assert.equal(artifacts?.length, 1);
  assert.equal(artifacts?.[0]?.state, "clean");
  assert.equal(artifacts?.[0]?.detail, null);
});

test("a partial update that omits detail preserves the previously published file list", async () => {
  const roomId = "local:room-preserve";
  const identity = {
    provider: "git",
    kind: "change_summary",
    id: "managed-agent:key:emmy/x:branch:feature/p",
    ref: "feature/p",
  };

  await publishLocalRoomWorkflowArtifact({
    roomId,
    artifact: {
      ...identity,
      state: "updated",
      detail: {
        type: "change_summary",
        version: 1,
        changedFileCount: 1,
        additions: 2,
        deletions: 0,
        stagedFileCount: 0,
        unstagedFileCount: 1,
        untrackedFileCount: 0,
        hiddenFileCount: 0,
        files: [
          {
            path: "src/keep.ts",
            previousPath: null,
            status: "modified",
            additions: 2,
            deletions: 0,
            binary: false,
            staged: false,
            unstaged: true,
            untracked: false,
          },
        ],
      },
    },
  });

  // Re-publish the same artifact with no detail and a non-clean state — the prior
  // file list must be preserved, not wiped.
  await publishLocalRoomWorkflowArtifact({
    roomId,
    artifact: { ...identity, state: "updated" },
  });

  const { artifacts } = await getLocalRoomArtifacts(roomId);
  assert.equal(artifacts?.length, 1);
  assert.equal(artifacts?.[0]?.detail?.files.length, 1);
  assert.equal(artifacts?.[0]?.detail?.files[0]?.path, "src/keep.ts");
});

test("an explicit null detail clears a previously published file list", async () => {
  const roomId = "local:room-explicitnull";
  const identity = {
    provider: "git",
    kind: "change_summary",
    id: "managed-agent:key:emmy/x:branch:feature/n",
    ref: "feature/n",
  };

  await publishLocalRoomWorkflowArtifact({
    roomId,
    artifact: {
      ...identity,
      state: "updated",
      detail: {
        type: "change_summary",
        version: 1,
        changedFileCount: 1,
        additions: 1,
        deletions: 0,
        stagedFileCount: 0,
        unstagedFileCount: 1,
        untrackedFileCount: 0,
        hiddenFileCount: 0,
        files: [
          {
            path: "src/n.ts",
            previousPath: null,
            status: "modified",
            additions: 1,
            deletions: 0,
            binary: false,
            staged: false,
            unstaged: true,
            untracked: false,
          },
        ],
      },
    },
  });

  // Explicit null (not omission) on a non-clean state must clear the list.
  await publishLocalRoomWorkflowArtifact({
    roomId,
    artifact: { ...identity, state: "updated", detail: null },
  });

  const { artifacts } = await getLocalRoomArtifacts(roomId);
  assert.equal(artifacts?.length, 1);
  assert.equal(artifacts?.[0]?.detail, null);
});

test("local store rejects change_summary detail while state is clean", async () => {
  await assert.rejects(() =>
    publishLocalRoomWorkflowArtifact({
      roomId: "local:room-cleaninvariant",
      artifact: {
        provider: "git",
        kind: "change_summary",
        id: "managed-agent:key:emmy/x:branch:feature/c",
        ref: "feature/c",
        state: "clean",
        detail: {
          type: "change_summary",
          version: 1,
          changedFileCount: 1,
          additions: 1,
          deletions: 0,
          stagedFileCount: 0,
          unstagedFileCount: 1,
          untrackedFileCount: 0,
          hiddenFileCount: 0,
          files: [
            {
              path: "src/x.ts",
              previousPath: null,
              status: "modified",
              additions: 1,
              deletions: 0,
              binary: false,
              staged: false,
              unstaged: true,
              untracked: false,
            },
          ],
        },
      },
    }),
  );
});

test("local store rejects change_summary detail on a non-change_summary kind", async () => {
  await assert.rejects(() =>
    publishLocalRoomWorkflowArtifact({
      roomId: "local:room-kindcheck",
      artifact: {
        provider: "github",
        kind: "pull_request",
        url: "https://github.com/x/y/pull/9",
        detail: {
          type: "change_summary",
          version: 1,
          changedFileCount: 0,
          additions: 0,
          deletions: 0,
          stagedFileCount: 0,
          unstagedFileCount: 0,
          untrackedFileCount: 0,
          hiddenFileCount: 0,
          files: [],
        },
      },
    }),
  );
});

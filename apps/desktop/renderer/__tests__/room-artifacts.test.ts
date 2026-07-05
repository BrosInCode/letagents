import assert from "node:assert/strict";
import { test } from "node:test";

import type { DesktopRoomSharedArtifact } from "../../electron/ipc-types";
import { roomArtifactTimelineItems } from "../src/domain/room-artifacts";

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

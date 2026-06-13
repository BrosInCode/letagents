import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DesktopGitHubRoomEvent } from "../../electron/ipc-types";
import {
  branchesMatch,
  coalesceDesktopGitHubEventPresentations,
  filterDesktopGitHubEventPresentations,
  groupDesktopGitHubEvents,
  presentDesktopGitHubEvent,
} from "../src/components/desktop/content/room-events/presenter";

describe("desktop GitHub event presenter", () => {
  it("marks failed current-branch checks as actionable failures", () => {
    const presented = presentDesktopGitHubEvent(githubEvent({
      eventType: "check_run",
      state: "failure",
      title: "deploy",
      metadata: { head_branch: "codex/desktop-events", app_name: "GitHub Actions" },
    }), "BrosInCode/letagents");

    assert.equal(presented.kind, "check");
    assert.equal(presented.tone, "danger");
    assert.equal(presented.isActionable, true);
    assert.equal(presented.isLowSignal, false);
    assert.equal(presented.sourceLabel, "GitHub Actions");
    assert.equal(branchesMatch(presented.branchRef, "codex/desktop-events"), true);
  });

  it("surfaces structured detail fields without exposing raw metadata", () => {
    const presented = presentDesktopGitHubEvent(githubEvent({
      eventType: "pull_request",
      title: "Add desktop GitHub Events tab",
      metadata: {
        body: "## Summary\n- add the Events tab",
        author_login: "EmmyMay",
        head_ref: "codex/desktop-github-events",
        head_sha: "1234567890abcdef",
      },
    }), "BrosInCode/letagents");

    assert.equal(presented.bodyText, "## Summary\n- add the Events tab");
    assert.equal(presented.sourceLabel, "EmmyMay");
    assert.equal(presented.branchRef, "codex/desktop-github-events");
    assert.equal(presented.commitSha, "1234567890abcdef");
  });

  it("keeps successful and skipped checks low signal outside actionable", () => {
    const success = presentDesktopGitHubEvent(githubEvent({
      id: "evt_success",
      eventType: "check_run",
      state: "success",
      title: "test",
    }));
    const skipped = presentDesktopGitHubEvent(githubEvent({
      id: "evt_skipped",
      eventType: "check_run",
      state: "skipped",
      title: "deploy",
      createdAt: "2026-06-12T10:01:00.000Z",
    }));

    assert.equal(success.isLowSignal, true);
    assert.equal(skipped.isLowSignal, true);
    assert.deepEqual(
      filterDesktopGitHubEventPresentations([success, skipped], { filter: "actionable" }),
      [],
    );
    assert.deepEqual(
      filterDesktopGitHubEventPresentations([success, skipped], { filter: "all" }).map((event) => event.id),
      ["evt_skipped", "evt_success"],
    );
  });

  it("filters reviews and linked task events", () => {
    const review = presentDesktopGitHubEvent(githubEvent({
      id: "evt_review",
      eventType: "pull_request_review",
      action: "submitted",
      state: "changes_requested",
      githubObjectId: "548",
      linkedTaskId: "task_174",
    }));
    const comment = presentDesktopGitHubEvent(githubEvent({
      id: "evt_comment",
      eventType: "issue_comment",
      action: "created",
      githubObjectId: "548",
      linkedTaskId: "task_175",
    }));

    assert.deepEqual(
      filterDesktopGitHubEventPresentations([review, comment], { filter: "reviews" }).map((event) => event.id),
      ["evt_review"],
    );
    assert.deepEqual(
      filterDesktopGitHubEventPresentations([review, comment], {
        filter: "all",
        linkedTaskId: "task_175",
      }).map((event) => event.id),
      ["evt_comment"],
    );
  });

  it("groups related object events together", () => {
    const events = [
      presentDesktopGitHubEvent(githubEvent({
        id: "evt_review",
        eventType: "pull_request_review",
        githubObjectId: "548",
        createdAt: "2026-06-12T10:00:00.000Z",
      })),
      presentDesktopGitHubEvent(githubEvent({
        id: "evt_comment",
        eventType: "issue_comment",
        githubObjectId: "548",
        createdAt: "2026-06-12T10:01:00.000Z",
        metadata: { is_pull_request: true },
      })),
    ];

    const groups = groupDesktopGitHubEvents(events);

    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.title, "PR #548");
    assert.deepEqual(groups[0]?.events.map((event) => event.id), ["evt_comment", "evt_review"]);
  });

  it("rolls repeated semantic events into one visible group entry", () => {
    const events = [
      presentDesktopGitHubEvent(githubEvent({
        id: "evt_open_latest",
        eventType: "pull_request",
        action: "opened",
        state: "open",
        githubObjectId: "558",
        title: "Polish desktop focus room manager",
        metadata: { head_sha: "sha_latest" },
        createdAt: "2026-06-12T12:00:00.000Z",
      })),
      presentDesktopGitHubEvent(githubEvent({
        id: "evt_open_middle",
        eventType: "pull_request",
        action: "opened",
        state: "open",
        githubObjectId: "558",
        title: "Polish desktop focus room manager",
        metadata: { head_sha: "sha_middle" },
        createdAt: "2026-06-12T11:00:00.000Z",
      })),
      presentDesktopGitHubEvent(githubEvent({
        id: "evt_open_old",
        eventType: "pull_request",
        action: "opened",
        state: "open",
        githubObjectId: "558",
        title: "Polish desktop focus room manager",
        metadata: { head_sha: "sha_old" },
        createdAt: "2026-06-10T11:00:00.000Z",
      })),
    ];

    const group = groupDesktopGitHubEvents(events)[0];

    assert.equal(group?.events.length, 3);
    assert.equal(group?.entries.length, 1);
    assert.equal(group?.entries[0]?.event.id, "evt_open_latest");
    assert.equal(group?.entries[0]?.hiddenCount, 2);
  });

  it("coalesces duplicate webhook deliveries for the same semantic event", () => {
    const olderDuplicate = presentDesktopGitHubEvent(githubEvent({
      id: "evt_open_old",
      eventType: "pull_request",
      action: "opened",
      state: "open",
      githubObjectId: "559",
      githubObjectUrl: "https://github.com/BrosInCode/letagents/pull/559",
      title: "Add desktop GitHub Events tab",
      metadata: { head_sha: "abc123" },
      createdAt: "2026-06-12T10:00:00.000Z",
    }));
    const newerDuplicate = presentDesktopGitHubEvent(githubEvent({
      id: "evt_open_new",
      eventType: "pull_request",
      action: "opened",
      state: "open",
      githubObjectId: "559",
      githubObjectUrl: "https://github.com/BrosInCode/letagents/pull/559",
      title: "Add desktop GitHub Events tab",
      metadata: { head_sha: "abc123" },
      createdAt: "2026-06-12T10:01:00.000Z",
    }));

    const events = coalesceDesktopGitHubEventPresentations([olderDuplicate, newerDuplicate]);

    assert.deepEqual(events.map((event) => event.id), ["evt_open_new"]);
    assert.deepEqual(groupDesktopGitHubEvents(events)[0]?.events.map((event) => event.id), ["evt_open_new"]);
  });
});

function githubEvent(overrides: Partial<DesktopGitHubRoomEvent> = {}): DesktopGitHubRoomEvent {
  return {
    id: "evt_1",
    eventType: "pull_request",
    action: "opened",
    githubObjectId: "548",
    githubObjectUrl: "https://github.com/BrosInCode/letagents/pull/548",
    title: null,
    state: "open",
    actorLogin: "EmmyMay",
    metadata: {},
    linkedTaskId: null,
    createdAt: "2026-06-12T10:00:00.000Z",
    ...overrides,
  };
}

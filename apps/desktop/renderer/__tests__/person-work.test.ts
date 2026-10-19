import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DesktopGitHubRoomEvent } from "../../electron/ipc-types";
import {
  buildPersonWork,
  loadRoomEventsOfType,
  type PersonWorkEvent,
  type PersonWorkEventPage,
} from "../src/domain/person-work";

const NOW = new Date("2026-10-13T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function pullRequestEvent(overrides: Partial<PersonWorkEvent> & { id: string }): PersonWorkEvent {
  return {
    eventType: "pull_request",
    action: "opened",
    githubObjectId: "12",
    githubObjectUrl: "https://github.com/acme/app/pull/12",
    title: "Add search",
    state: "open",
    actorLogin: "mira",
    metadata: { author_login: "mira" },
    linkedTaskId: null,
    eventOrderAt: "2026-10-12T10:00:00.000Z",
    createdAt: "2026-10-12T10:00:00.000Z",
    ...overrides,
  };
}

function reviewEvent(overrides: Partial<PersonWorkEvent> & { id: string }): PersonWorkEvent {
  return {
    eventType: "pull_request_review",
    action: "submitted",
    githubObjectId: "12",
    githubObjectUrl: "https://github.com/acme/app/pull/12#pullrequestreview-900",
    title: "Add search",
    state: "approved",
    actorLogin: "owen",
    metadata: { pull_request_author_login: "mira" },
    linkedTaskId: null,
    eventOrderAt: "2026-10-12T11:00:00.000Z",
    createdAt: "2026-10-12T11:00:00.000Z",
    ...overrides,
  };
}

function withRoom(event: PersonWorkEvent, roomId: string): PersonWorkEvent {
  return { ...event, roomId } as PersonWorkEvent;
}

function requestEvent(overrides: Partial<DesktopGitHubRoomEvent> & { id: string; metadata: Record<string, unknown> }): PersonWorkEvent {
  return pullRequestEvent({
    action: "review_requested",
    eventOrderAt: "2026-10-12T12:00:00.000Z",
    createdAt: "2026-10-12T12:00:00.000Z",
    ...overrides,
  });
}

describe("buildPersonWork authorship and open pull requests", () => {
  it("counts an open pull request by its author_login metadata", () => {
    const work = buildPersonWork(
      [pullRequestEvent({ id: "evt_1" })],
      "mira",
      NOW,
    );
    assert.equal(work.openPrs.length, 1);
    assert.equal(work.openPrs[0].prNumber, 12);
    assert.equal(work.openPrs[0].title, "Add search");
    assert.equal(work.openPrs[0].state, "open");
    assert.equal(work.openPrs[0].note, null);
  });

  it("falls back to the oldest pull request event actor when metadata has no author", () => {
    const opened = pullRequestEvent({
      id: "evt_open",
      metadata: {},
      actorLogin: "mira",
      eventOrderAt: "2026-10-12T09:00:00.000Z",
    });
    const synced = pullRequestEvent({
      id: "evt_sync",
      action: "synchronize",
      metadata: {},
      actorLogin: "ci-bot",
      eventOrderAt: "2026-10-12T10:00:00.000Z",
    });
    const work = buildPersonWork([synced, opened], "mira", NOW);
    assert.equal(work.openPrs.length, 1);
  });

  it("reads the review author from pull_request_author_login", () => {
    // The pull request event names owen, so only the review metadata can make mira the author.
    const work = buildPersonWork(
      [
        pullRequestEvent({ id: "evt_1", metadata: {}, actorLogin: "owen" }),
        reviewEvent({ id: "evt_review", metadata: { pull_request_author_login: "mira" }, actorLogin: "owen" }),
      ],
      "mira",
      NOW,
    );
    assert.equal(work.openPrs.length, 1);
  });

  it("lists a closed and reopened pull request as open, not merged", () => {
    const work = buildPersonWork(
      [
        pullRequestEvent({ id: "evt_1", eventOrderAt: "2026-10-12T10:00:00.000Z", createdAt: "2026-10-12T10:00:00.000Z" }),
        pullRequestEvent({
          id: "evt_closed",
          action: "closed",
          state: "closed",
          eventOrderAt: "2026-10-12T11:00:00.000Z",
          createdAt: "2026-10-12T11:00:00.000Z",
        }),
        pullRequestEvent({
          id: "evt_reopened",
          action: "reopened",
          state: "open",
          eventOrderAt: "2026-10-12T12:00:00.000Z",
          createdAt: "2026-10-12T12:00:00.000Z",
        }),
      ],
      "mira",
      NOW,
    );
    assert.equal(work.openPrs.length, 1);
    assert.equal(work.openPrs[0].state, "open");
    assert.equal(work.mergedRecently.length, 0);
  });

  it("lists a pull request that has only review events under reviews, with no author", () => {
    const events = [
      reviewEvent({ id: "evt_review", actorLogin: "mira", metadata: {}, state: "approved" }),
    ];
    const reviewer = buildPersonWork(events, "mira", NOW);
    const other = buildPersonWork(events, "owen", NOW);
    assert.equal(reviewer.reviewed.length, 1);
    assert.equal(reviewer.reviewed[0].state, "unknown");
    assert.equal(reviewer.openPrs.length, 0);
    assert.equal(other.openPrs.length, 0);
    assert.equal(other.reviewed.length, 0);
  });

  it("dates a merge by its first merged event, so a later merged event does not move it into the window", () => {
    const merged = new Date(NOW.getTime() - 30 * HOUR_MS).toISOString();
    const later = new Date(NOW.getTime() - HOUR_MS).toISOString();
    const work = buildPersonWork(
      [
        pullRequestEvent({ id: "evt_merged", action: "closed", state: "merged", eventOrderAt: merged, createdAt: merged }),
        pullRequestEvent({ id: "evt_sync", action: "synchronize", state: "merged", eventOrderAt: later, createdAt: later }),
      ],
      "mira",
      NOW,
    );
    assert.equal(work.mergedRecently.length, 0);
  });

  it("lists a draft pull request as draft and does not list other people's pull requests", () => {
    const work = buildPersonWork(
      [
        pullRequestEvent({ id: "evt_draft", metadata: { author_login: "mira", draft: true } }),
        pullRequestEvent({
          id: "evt_other",
          githubObjectId: "13",
          githubObjectUrl: "https://github.com/acme/app/pull/13",
          metadata: { author_login: "owen" },
          actorLogin: "owen",
        }),
      ],
      "mira",
      NOW,
    );
    assert.equal(work.openPrs.length, 1);
    assert.equal(work.openPrs[0].state, "draft");
    assert.equal(work.openPrs[0].prNumber, 12);
  });

  it("drops a pull request once its newest event closes it", () => {
    const work = buildPersonWork(
      [
        pullRequestEvent({ id: "evt_1" }),
        pullRequestEvent({
          id: "evt_2",
          action: "closed",
          state: "closed",
          eventOrderAt: "2026-10-12T13:00:00.000Z",
        }),
      ],
      "mira",
      NOW,
    );
    assert.equal(work.openPrs.length, 0);
    assert.equal(work.mergedRecently.length, 0);
  });
});

describe("buildPersonWork merged pull requests", () => {
  it("lists a pull request merged 23 hours ago for its author", () => {
    const mergedAt = new Date(NOW.getTime() - 23 * HOUR_MS).toISOString();
    const work = buildPersonWork(
      [pullRequestEvent({ id: "evt_merged", action: "closed", state: "merged", eventOrderAt: mergedAt, createdAt: mergedAt })],
      "mira",
      NOW,
    );
    assert.equal(work.mergedRecently.length, 1);
    assert.equal(work.mergedRecently[0].state, "merged");
    assert.equal(work.mergedRecently[0].note, null);
  });

  it("includes a merge exactly 24 hours old and excludes one a millisecond older", () => {
    const exactly = new Date(NOW.getTime() - 24 * HOUR_MS).toISOString();
    const justOver = new Date(NOW.getTime() - 24 * HOUR_MS - 1).toISOString();
    const inside = buildPersonWork(
      [pullRequestEvent({ id: "evt_edge", action: "closed", state: "merged", eventOrderAt: exactly, createdAt: exactly })],
      "mira",
      NOW,
    );
    const outside = buildPersonWork(
      [pullRequestEvent({ id: "evt_old", action: "closed", state: "merged", eventOrderAt: justOver, createdAt: justOver })],
      "mira",
      NOW,
    );
    assert.equal(inside.mergedRecently.length, 1);
    assert.equal(outside.mergedRecently.length, 0);
  });

  it("names who merged a pull request when it was someone else", () => {
    const mergedAt = new Date(NOW.getTime() - HOUR_MS).toISOString();
    const work = buildPersonWork(
      [pullRequestEvent({
        id: "evt_merged",
        action: "closed",
        state: "merged",
        eventOrderAt: mergedAt,
        createdAt: mergedAt,
        metadata: { author_login: "mira", merged_by_login: "owen" },
      })],
      "mira",
      NOW,
    );
    assert.equal(work.mergedRecently[0].note, "merged by owen");
  });

  it("includes a pull request the person merged even when someone else wrote it", () => {
    const mergedAt = new Date(NOW.getTime() - HOUR_MS).toISOString();
    const work = buildPersonWork(
      [pullRequestEvent({
        id: "evt_merged",
        action: "closed",
        state: "merged",
        eventOrderAt: mergedAt,
        createdAt: mergedAt,
        actorLogin: "owen",
        metadata: { author_login: "owen", merged_by_login: "mira" },
      })],
      "mira",
      NOW,
    );
    assert.equal(work.mergedRecently.length, 1);
    assert.equal(work.mergedRecently[0].note, null);
  });
});

describe("buildPersonWork review requests", () => {
  it("lists a pull request waiting for the person as reviewer", () => {
    const work = buildPersonWork(
      [
        pullRequestEvent({ id: "evt_pr", metadata: { author_login: "owen" }, actorLogin: "owen" }),
        requestEvent({
          id: "evt_req",
          metadata: { participant: { role: "reviewer", change: "added", login: "mira" } },
        }),
      ],
      "mira",
      NOW,
    );
    assert.equal(work.needsTheirReview.length, 1);
    assert.equal(work.needsTheirReview[0].title, "Add search");
  });

  it("clears the request once the person reviews after it", () => {
    const work = buildPersonWork(
      [
        pullRequestEvent({ id: "evt_pr", metadata: { author_login: "owen" }, actorLogin: "owen" }),
        requestEvent({
          id: "evt_req",
          metadata: { participant: { role: "reviewer", change: "added", login: "mira" } },
        }),
        reviewEvent({
          id: "evt_review",
          actorLogin: "mira",
          state: "commented",
          eventOrderAt: "2026-10-12T13:00:00.000Z",
          createdAt: "2026-10-12T13:00:00.000Z",
        }),
      ],
      "mira",
      NOW,
    );
    assert.equal(work.needsTheirReview.length, 0);
    assert.equal(work.reviewed.length, 1);
    assert.equal(work.reviewed[0].note, "commented");
  });

  it("clears the request when the newest participant change is removed", () => {
    const work = buildPersonWork(
      [
        pullRequestEvent({ id: "evt_pr", metadata: { author_login: "owen" }, actorLogin: "owen" }),
        requestEvent({
          id: "evt_req",
          metadata: { participant: { role: "reviewer", change: "added", login: "mira" } },
        }),
        requestEvent({
          id: "evt_removed",
          action: "review_request_removed",
          eventOrderAt: "2026-10-12T14:00:00.000Z",
          createdAt: "2026-10-12T14:00:00.000Z",
          metadata: { participant: { role: "reviewer", change: "removed", login: "mira" } },
        }),
      ],
      "mira",
      NOW,
    );
    assert.equal(work.needsTheirReview.length, 0);
  });

  it("matches the reviewer login case-insensitively and ignores closed pull requests", () => {
    const requested = requestEvent({
      id: "evt_req",
      metadata: { participant: { role: "reviewer", change: "added", login: "MIRA" } },
    });
    const open = buildPersonWork(
      [pullRequestEvent({ id: "evt_pr", metadata: { author_login: "owen" }, actorLogin: "owen" }), requested],
      "Mira",
      NOW,
    );
    const closed = buildPersonWork(
      [
        pullRequestEvent({ id: "evt_pr", metadata: { author_login: "owen" }, actorLogin: "owen" }),
        requested,
        pullRequestEvent({
          id: "evt_closed",
          action: "closed",
          state: "closed",
          metadata: { author_login: "owen" },
          actorLogin: "owen",
          eventOrderAt: "2026-10-12T15:00:00.000Z",
        }),
      ],
      "mira",
      NOW,
    );
    assert.equal(open.needsTheirReview.length, 1);
    assert.equal(closed.needsTheirReview.length, 0);
  });
});

describe("buildPersonWork reviews and login rules", () => {
  it("groups review events under their pull request and names the review state", () => {
    const work = buildPersonWork(
      [
        pullRequestEvent({ id: "evt_pr", metadata: { author_login: "owen" }, actorLogin: "owen" }),
        reviewEvent({ id: "evt_review", actorLogin: "Mira", state: "changes_requested" }),
      ],
      "mira",
      NOW,
    );
    assert.equal(work.reviewed.length, 1);
    assert.equal(work.reviewed[0].prNumber, 12);
    assert.equal(work.reviewed[0].prUrl, "https://github.com/acme/app/pull/12");
    assert.equal(work.reviewed[0].note, "changes requested");
    assert.equal(work.reviewed[0].state, "open");
  });

  it("keeps only the newest review per pull request", () => {
    const work = buildPersonWork(
      [
        reviewEvent({ id: "evt_old", actorLogin: "mira", state: "commented", eventOrderAt: "2026-10-12T11:00:00.000Z" }),
        reviewEvent({ id: "evt_new", actorLogin: "mira", state: "approved", eventOrderAt: "2026-10-12T16:00:00.000Z" }),
      ],
      "mira",
      NOW,
    );
    assert.equal(work.reviewed.length, 1);
    assert.equal(work.reviewed[0].note, "approved");
  });

  it("does not list reviews on a merged pull request", () => {
    const mergedAt = new Date(NOW.getTime() - HOUR_MS).toISOString();
    const work = buildPersonWork(
      [
        pullRequestEvent({ id: "evt_merged", action: "closed", state: "merged", eventOrderAt: mergedAt, createdAt: mergedAt, metadata: { author_login: "owen" }, actorLogin: "owen" }),
        reviewEvent({ id: "evt_review", actorLogin: "mira", state: "approved" }),
      ],
      "mira",
      NOW,
    );
    assert.equal(work.reviewed.length, 0);
  });

  it("matches the login case-insensitively for authorship", () => {
    const work = buildPersonWork(
      [pullRequestEvent({ id: "evt_1", metadata: { author_login: "Mira" } })],
      "MIRA",
      NOW,
    );
    assert.equal(work.openPrs.length, 1);
  });

  it("returns empty buckets for an empty login", () => {
    const work = buildPersonWork([pullRequestEvent({ id: "evt_1" })], "  ", NOW);
    assert.deepEqual(work, { openPrs: [], needsTheirReview: [], reviewed: [], mergedRecently: [] });
  });

  it("keeps the room of each event and leaves it empty when the event has none", () => {
    const focusEvent = withRoom(pullRequestEvent({ id: "evt_focus" }), "focus_27");
    const repoEvent = pullRequestEvent({
      id: "evt_repo",
      githubObjectId: "14",
      githubObjectUrl: "https://github.com/acme/app/pull/14",
      title: "Fix login",
    });
    const work = buildPersonWork([focusEvent, repoEvent], "mira", NOW);
    const byNumber = new Map(work.openPrs.map((row) => [row.prNumber, row]));
    assert.equal(byNumber.get(12)?.roomId, "focus_27");
    assert.equal(byNumber.get(14)?.roomId, "");
  });

  it("sorts each bucket by updatedAt, newest first", () => {
    const older = pullRequestEvent({
      id: "evt_a",
      githubObjectId: "20",
      githubObjectUrl: "https://github.com/acme/app/pull/20",
      eventOrderAt: "2026-10-10T10:00:00.000Z",
      createdAt: "2026-10-10T10:00:00.000Z",
    });
    const newer = pullRequestEvent({
      id: "evt_b",
      githubObjectId: "21",
      githubObjectUrl: "https://github.com/acme/app/pull/21",
      eventOrderAt: "2026-10-12T10:00:00.000Z",
      createdAt: "2026-10-12T10:00:00.000Z",
    });
    const work = buildPersonWork([older, newer], "mira", NOW);
    assert.deepEqual(work.openPrs.map((row) => row.prNumber), [21, 20]);
  });
});

describe("loadRoomEventsOfType", () => {
  function eventWithId(id: string): DesktopGitHubRoomEvent {
    return pullRequestEvent({ id });
  }

  /** Serve pages in order; record the cursor each call received. */
  function pagesFrom(pages: PersonWorkEventPage[]) {
    const cursors: Array<string | null> = [];
    let index = 0;
    const fetchPage = async (options: { after: string | null }) => {
      cursors.push(options.after);
      const page = pages[Math.min(index, pages.length - 1)];
      index += 1;
      return page;
    };
    return { fetchPage, cursors };
  }

  it("reads two pages, then stops when hasMore is false", async () => {
    const { fetchPage, cursors } = pagesFrom([
      { events: [eventWithId("e1"), eventWithId("e2")], hasMore: true },
      { events: [eventWithId("e3")], hasMore: false },
    ]);
    const result = await loadRoomEventsOfType(fetchPage, { maxEvents: 100 });
    assert.deepEqual(result.events.map((event) => event.id), ["e1", "e2", "e3"]);
    assert.equal(result.truncated, false);
    assert.deepEqual(cursors, [null, "e2"]);
  });

  it("stops when a page repeats the cursor, even with a new event before it", async () => {
    const { fetchPage, cursors } = pagesFrom([
      { events: [eventWithId("e1"), eventWithId("e2")], hasMore: true },
      { events: [eventWithId("e3"), eventWithId("e2")], hasMore: true },
      { events: [eventWithId("e4")], hasMore: true },
    ]);
    const result = await loadRoomEventsOfType(fetchPage, { maxEvents: 100 });
    assert.deepEqual(result.events.map((event) => event.id), ["e1", "e2", "e3"]);
    assert.equal(result.truncated, false);
    assert.deepEqual(cursors, [null, "e2"]);
  });

  it("reports truncation when the cap stops a loop that still has more pages", async () => {
    const { fetchPage, cursors } = pagesFrom([
      { events: [eventWithId("e1"), eventWithId("e2")], hasMore: true },
      { events: [eventWithId("e3")], hasMore: true },
    ]);
    const result = await loadRoomEventsOfType(fetchPage, { maxEvents: 2 });
    assert.equal(result.events.length, 2);
    assert.equal(result.truncated, true);
    assert.deepEqual(cursors, [null]);
  });

  it("does not report truncation when the cap is reached on the last page", async () => {
    const { fetchPage } = pagesFrom([
      { events: [eventWithId("e1"), eventWithId("e2")], hasMore: false },
    ]);
    const result = await loadRoomEventsOfType(fetchPage, { maxEvents: 2 });
    assert.equal(result.events.length, 2);
    assert.equal(result.truncated, false);
  });

  it("stops at a page that adds nothing new", async () => {
    const { fetchPage, cursors } = pagesFrom([
      { events: [eventWithId("e1")], hasMore: true },
      { events: [eventWithId("e1")], hasMore: true },
      { events: [eventWithId("e9")], hasMore: true },
    ]);
    const result = await loadRoomEventsOfType(fetchPage, { maxEvents: 100 });
    assert.deepEqual(result.events.map((event) => event.id), ["e1"]);
    assert.equal(result.truncated, false);
    assert.deepEqual(cursors, [null, "e1"]);
  });
});

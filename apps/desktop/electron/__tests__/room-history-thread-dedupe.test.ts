import assert from "node:assert/strict";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";
createElectronTestEnv({ prefix: "letagents-history-dedupe-", paths: ["state", "chatStorage", "localChatDb", "localProfile"] });
const {
  expandRoomMessageHistoryPage,
  ROOM_MESSAGE_HISTORY_DEDUPED_QUERY,
} = await import("../main/rooms/messages/mappers.js");
const { fetchRoomSnapshotData } = await import("../main/rooms/snapshot/fetch-data.js");
const { getDesktopRoomMessagesAfter, getDesktopRoomMessagesBefore } = await import("../main/rooms/messages.js");

const roomIdentifier = "github.com/test/history-dedupe";

function summary(rootId: string, replyCount: number, latestText: string) {
  return {
    root_message_id: rootId,
    reply_count: replyCount,
    unread_count: 1,
    has_unread: true,
    latest_reply: {
      id: "msg_12", sender: "Cy", text: latestText, source: null,
      timestamp: "2026-11-10T10:00:12.000Z", agent_identity: null,
    },
    participants: [
      { sender: "Cy", source: null, message_count: 1, latest_message_id: "msg_12" },
      { sender: "Ada", source: "browser", message_count: 1, latest_message_id: rootId },
    ],
    participant_count: 2,
    participants_truncated: false,
    last_read_message_id: null,
  };
}

function message(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    sender: "Ada",
    text: `Text of ${id}`,
    source: null,
    timestamp: `2026-11-10T10:00:${id.slice(4).padStart(2, "0")}.000Z`,
    thread_root_id: null,
    thread: null,
    reply_to: null,
    attachments: [],
    reactions: [],
    ...extra,
  };
}

/** A classic page: a thread rooted in the page, and a reply whose root (msg_5) is outside it. */
function classicPage() {
  const threadA = summary("msg_10", 2, "Latest reply in A");
  const threadOld = summary("msg_5", 3, "Latest reply in the old thread");
  return {
    room_id: "room_1",
    messages: [
      message("msg_10", { thread: threadA }),
      message("msg_11", { thread_root_id: "msg_10", thread: threadA, reply_to: { id: "msg_10", sender: "Ada", text: "Text of msg_10", source: null, timestamp: "2026-11-10T10:00:10.000Z", agent_identity: null } }),
      message("msg_12", { thread_root_id: "msg_10", thread: threadA }),
      message("msg_13"),
      message("msg_14", { thread_root_id: "msg_5", thread: threadOld, reply_to: { id: "msg_5", sender: "Ada", text: "Text of msg_5", source: null, timestamp: "2026-11-10T10:00:05.000Z", agent_identity: null } }),
    ],
    has_more: true,
    has_older: true,
  };
}

function compactPage() {
  const classic = classicPage();
  return {
    room_id: classic.room_id,
    thread_summaries: "deduped",
    threads: {
      msg_10: summary("msg_10", 2, "Latest reply in A"),
      msg_5: summary("msg_5", 3, "Latest reply in the old thread"),
    },
    messages: classic.messages.map((entry) => ({
      ...entry,
      thread: entry.thread ? (entry.thread as { root_message_id: string }).root_message_id : null,
    })),
    has_more: classic.has_more,
    has_older: classic.has_older,
  };
}

test("the expander turns a deduped page back into the classic page", () => {
  const expanded = expandRoomMessageHistoryPage(compactPage() as any);
  assert.deepEqual(expanded, classicPage());
  assert.equal("thread_summaries" in expanded, false);
  assert.equal("threads" in expanded, false);
  assert.notEqual(expanded.messages![0]!.thread, expanded.messages![1]!.thread, "each message gets its own copy");
});

test("the expander passes a classic page from an older server through unchanged", () => {
  const classic = classicPage();
  assert.equal(expandRoomMessageHistoryPage(classic as any), classic);
  assert.deepEqual(expandRoomMessageHistoryPage(classic as any), classicPage());
});

test("the expander keeps a reply whose root is outside the page, and an empty page", () => {
  const compact = compactPage();
  const onlyOutsideReply = { ...compact, messages: [compact.messages[4]] };
  assert.deepEqual(expandRoomMessageHistoryPage(onlyOutsideReply as any).messages, [classicPage().messages[4]]);
  assert.deepEqual(
    expandRoomMessageHistoryPage({ room_id: "room_1", thread_summaries: "deduped", threads: {}, messages: [], has_more: false } as any),
    { room_id: "room_1", messages: [], has_more: false },
  );
  assert.deepEqual(expandRoomMessageHistoryPage({ messages: [] } as any), { messages: [] });
  const missing = expandRoomMessageHistoryPage({ thread_summaries: "deduped", threads: {}, messages: [message("msg_20", { thread: "msg_19" })] } as any);
  assert.equal(missing.messages![0]!.thread, null, "an unknown key never invents a summary");
});

async function withServer<T>(form: "classic" | "deduped", run: (calls: string[]) => Promise<T>): Promise<T> {
  const prior = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    let payload: unknown = {};
    if (/\/messages\/msg_5\/thread\?/.test(url)) {
      payload = {
        root: message("msg_5", { thread: summary("msg_5", 3, "Latest reply in the old thread") }),
        replies: [],
        has_older: false,
      };
    } else if (/\/messages\?/.test(url)) {
      payload = form === "deduped" && url.includes(ROOM_MESSAGE_HISTORY_DEDUPED_QUERY) ? compactPage() : classicPage();
    }
    return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = prior;
  }
}

test("the room snapshot asks for the deduped page and gets the same messages from a new or an old server", async () => {
  const fromNew = await withServer("deduped", async (calls) => {
    const snapshot = await fetchRoomSnapshotData(roomIdentifier);
    const history = calls.filter((url) => /\/messages\?/.test(url));
    assert.equal(history.length, 1);
    assert.ok(history[0]!.includes("before=latest") && history[0]!.includes(ROOM_MESSAGE_HISTORY_DEDUPED_QUERY));
    assert.ok(calls.some((url) => url.includes("/messages/msg_5/thread?")), "the root outside the page is fetched");
    return snapshot.messagesData.messages ?? [];
  });
  const fromOld = await withServer("classic", async () => (await fetchRoomSnapshotData(roomIdentifier)).messagesData.messages ?? []);
  assert.deepEqual(fromNew, fromOld);
  assert.deepEqual(fromNew.map((entry) => entry.id), ["msg_5", "msg_10", "msg_11", "msg_12", "msg_13", "msg_14"]);
  assert.deepEqual(fromNew.find((entry) => entry.id === "msg_14")!.thread, summary("msg_5", 3, "Latest reply in the old thread"));
});

test("history paging maps the deduped page exactly like the classic page", async () => {
  const loads: Array<() => Promise<{ messages: Awaited<ReturnType<typeof getDesktopRoomMessagesAfter>>["messages"] }>> = [
    () => getDesktopRoomMessagesBefore(roomIdentifier, "msg_30"),
    () => getDesktopRoomMessagesAfter(roomIdentifier, "msg_1"),
  ];
  for (const load of loads) {
    const fromNew = await withServer("deduped", async (calls) => {
      const page = await load();
      assert.ok(calls.some((url) => url.includes(ROOM_MESSAGE_HISTORY_DEDUPED_QUERY)));
      return page;
    });
    const fromOld = await withServer("classic", load);
    assert.deepEqual(fromNew, fromOld);
    assert.equal(fromNew.messages.find((entry) => entry.id === "msg_14")!.thread!.latestReply!.text, "Latest reply in the old thread");
  }
});

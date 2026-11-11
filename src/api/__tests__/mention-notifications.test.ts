import assert from "node:assert/strict";
import test from "node:test";

import { extractMentionedLogins } from "../../../shared/room-notification-preferences.mjs";
import { parseRoomMentionEvent } from "../../../shared/room-mention-events.mjs";

process.env.DB_URL ??= "postgres://127.0.0.1:1/x";

const {
  isHiddenAgentStatusMessage,
  resolveMentionedAccountIds,
  selectUnambiguousMentionedAccountIds,
} = await import("../notifications/mention-accounts.js");
const {
  ROOM_MENTION_CREATED,
  announceRoomMentionCreated,
  readRoomMentionCreatedEvent,
  roomMentionEvents,
  roomMentionStreamPayload,
} = await import("../rooms/mention-events.js");
const { dispatchBridgeNotification } = await import("../server/event-bridge/notification-dispatch.js");
const { roomEventBridgeLossEvents } = await import("../server/bridged-emitter.js");
const { enqueueDesktopPushNotifications } = await import("../notifications/enqueue.js");
const { resolveMessageNotificationTargets } = await import("../server/events.js");

test("extractMentionedLogins parses person handles, deduplicates case-insensitively, and skips agent/broadcast tokens", () => {
  assert.deepEqual(extractMentionedLogins("plain message with no handles"), []);
  assert.deepEqual(
    extractMentionedLogins(
      "Hey @EmmyMay, (@emmymay) and @Ada.Lovelace. Ignore @everyone @agents mail@ada.com @agent:emmymay/fjordspring @emmymay/bot",
    ),
    ["emmymay", "ada.lovelace"],
  );
  assert.deepEqual(extractMentionedLogins("@a @b @c", 2), ["a", "b"]);
});

test("selectUnambiguousMentionedAccountIds skips duplicate logins across accounts and excludes the human publisher", async () => {
  const rows = [
    { id: "acct_emmy", login: "EmmyMay" },
    { id: "acct_dup_1", login: "shared-login" },
    { id: "acct_dup_2", login: "SHARED-LOGIN" },
    { id: "acct_reviewer", login: "reviewer" },
  ];

  assert.deepEqual(
    selectUnambiguousMentionedAccountIds(rows, ["emmymay", "shared-login", "reviewer"], "acct_emmy"),
    ["acct_reviewer"],
    "human self-mention and ambiguous duplicate login are both excluded",
  );

  const viaResolver = await resolveMentionedAccountIds("Ping @EmmyMay @shared-login @reviewer @unknown", {
    excludeAccountId: null,
    findAccountsByLowerLogins: async (logins) => {
      assert.deepEqual(logins, ["emmymay", "shared-login", "reviewer", "unknown"]);
      return rows;
    },
  });
  assert.deepEqual(viaResolver, ["acct_emmy", "acct_reviewer"]);
});

test("resolveMessageNotificationTargets distinguishes human self-mentions from an owner's agent mentioning the owner", async () => {
  const lookup = async (text: string, excludeAccountId: string | null) =>
    resolveMentionedAccountIds(text, {
      excludeAccountId,
      findAccountsByLowerLogins: async () => [
        { id: "acct_owner", login: "EmmyMay" },
        { id: "acct_peer", login: "peer" },
      ],
    });

  // Human posting their own message mentioning themselves: excluded.
  const humanPost = await resolveMessageNotificationTargets(
    {
      projectId: "focus_103",
      text: "Note to self @EmmyMay and cc @peer",
      source: "browser",
      account_id: "acct_owner",
      publisher_agent_key: null,
    },
    {
      resolveMentionAccounts: lookup,
      resolveAccess: async () => "allow",
    },
  );
  assert.deepEqual(humanPost, {
    notify_account_ids: ["acct_peer"],
    recents_account_ids: ["acct_peer"],
    mention_notify_account_ids: ["acct_peer"],
    human_publisher_account_id: "acct_owner",
  });

  // Owner's agent mentioning `@EmmyMay`: included because `publisher_agent_key` is present!
  const agentPost = await resolveMessageNotificationTargets(
    {
      projectId: "focus_103",
      text: "@EmmyMay PR is ready for review",
      source: "agent",
      account_id: "acct_owner",
      publisher_agent_key: "EmmyMay/fjordspring",
    },
    {
      resolveMentionAccounts: lookup,
      resolveAccess: async () => "allow",
    },
  );
  assert.deepEqual(agentPost, {
    notify_account_ids: ["acct_owner"],
    recents_account_ids: ["acct_owner"],
    mention_notify_account_ids: ["acct_owner"],
    human_publisher_account_id: null,
  });
});

test("resolveMessageNotificationTargets suppresses prompt-only, addressed, hidden [status], denied, and github-text mentions", async () => {
  assert.equal(isHiddenAgentStatusMessage("agent", "[status] working on @EmmyMay task"), true);
  assert.equal(isHiddenAgentStatusMessage("browser", "[status] human wrote literal text"), false);

  let mentionCalls = 0;
  const countMentions = async () => {
    mentionCalls += 1;
    return ["acct_target"];
  };

  for (const suppressed of [
    { projectId: "focus_103", text: "", source: "agent", agent_prompt_kind: "auto" as const },
    { projectId: "focus_103", text: "@EmmyMay secret", source: "agent", addressed_to: { agent_key: "k" } as never },
    { projectId: "focus_103", text: "[status] pinging @EmmyMay", source: "agent" },
  ]) {
    const res = await resolveMessageNotificationTargets(suppressed, {
      resolveMentionAccounts: countMentions,
      resolveAccess: async () => "allow",
    });
    assert.deepEqual(res.notify_account_ids, []);
    assert.deepEqual(res.recents_account_ids, []);
    assert.deepEqual(res.mention_notify_account_ids, []);
  }
  assert.equal(mentionCalls, 0, "suppressed messages never query accounts");

  // `source: "github"` resolves strictly via `notify_github_users` (immutable github_user_id), never `@login` text.
  const githubMsg = await resolveMessageNotificationTargets(
    {
      projectId: "github.com/org/repo",
      text: "PR #12 opened mentioning @spoofed-login",
      source: "github",
      notify_github_users: [{ login: "reviewer", github_user_id: "42" }],
    },
    {
      resolveGitHubAccounts: async () => ["acct_github_42"],
      resolveMentionAccounts: countMentions,
      resolveAccess: async ({ accountId }) => (accountId === "acct_github_42" ? "retry" : "deny"),
    },
  );
  assert.equal(mentionCalls, 0, "github webhook messages never resolve text @logins");
  assert.deepEqual(githubMsg.notify_account_ids, ["acct_github_42"]);
  assert.deepEqual(githubMsg.recents_account_ids, []);
  assert.deepEqual(githubMsg.mention_notify_account_ids, []);
});

test("enqueueDesktopPushNotifications suppresses own-agent ordinary fan-out while permitting own-agent explicit @owner mentions and blocking human self-mentions", async () => {
  const statements: string[] = [];
  const flattenSql = (chunk: any): string => {
    if (chunk === null) return "<NULL>";
    if (typeof chunk === "string" || typeof chunk === "number") return String(chunk);
    if (Array.isArray(chunk)) return chunk.map(flattenSql).join("");
    if (chunk && typeof chunk === "object") {
      if ("value" in chunk && Array.isArray(chunk.value)) return chunk.value.join("");
      if ("queryChunks" in chunk && Array.isArray(chunk.queryChunks)) return chunk.queryChunks.map(flattenSql).join("");
    }
    return "";
  };
  const fakeTx = {
    execute: async (query: unknown) => {
      statements.push(flattenSql(query));
      return { rowCount: 1 };
    },
  };

  const baseMessage = {
    room_id: "focus_103",
    number: 12,
    reply_to_number: null,
    thread_root_number: null,
    sender: "FjordSpring | EmmyMay's agent | Agent",
    text: "ordinary status update without mention",
    agent_prompt_kind: null,
    source: "agent",
    client_message_id: null,
    publisher_agent_key: "EmmyMay/fjordspring",
    publisher_agent_session_id: "agent_session_1510",
    publisher_account_id: "acct_owner",
    routing_snapshot_version: null,
    timestamp: "2026-11-11T00:00:00.000Z",
  };

  // 1. Own-agent ordinary message (no @mention): only normal roomPushes runs, and it excludes publisher_account_id.
  await enqueueDesktopPushNotifications(fakeTx as never, baseMessage);
  assert.equal(statements.length, 1);
  assert.ok(
    statements[0]!.includes("acct_owner::text IS NULL"),
    "ordinary own-agent message must still exclude publisher_account_id on room-wide All messages fan-out",
  );

  // 2. Own-agent explicit @owner mention: normal roomPushes still excludes publisher_account_id,
  //    while targeted push + targeted recents pass null humanPublisherAccountId so the owner is notified.
  statements.length = 0;
  await enqueueDesktopPushNotifications(
    fakeTx as never,
    { ...baseMessage, text: "@EmmyMay done" },
    {
      notify_account_ids: ["acct_owner"],
      recents_account_ids: ["acct_owner"],
    },
  );
  assert.equal(statements.length, 3);
  assert.ok(statements[0]!.includes("acct_owner::text IS NULL"), "normal roomPushes preserves publisher exclusion");
  for (const targetedSql of statements.slice(1)) {
    assert.ok(!targetedSql.includes("acct_owner::text IS NULL"), "targeted own-agent mention must not exclude owner as human publisher");
    assert.ok(targetedSql.includes("<NULL>::text IS NULL"), "humanPublisherAccountId is null when publisher_agent_key is set");
  }

  // 3. Human self-message: all queries exclude publisher_account_id.
  statements.length = 0;
  await enqueueDesktopPushNotifications(
    fakeTx as never,
    { ...baseMessage, text: "@EmmyMay note", publisher_agent_key: null, source: "browser", sender: "EmmyMay" },
    { notify_account_ids: ["acct_other"], recents_account_ids: ["acct_other"] },
  );
  assert.equal(statements.length, 3);
  for (const sqlText of statements) {
    assert.ok(sqlText.includes("acct_owner::text IS NULL"), "human self-publication excludes publisher_account_id everywhere");
  }
});

test("roomMentionEvents bridges inline without bridge loss even with no external stream subscribers", async () => {
  const losses: unknown[] = [];
  const onLoss = (loss: unknown) => losses.push(loss);
  roomEventBridgeLossEvents.on("loss", onLoss);
  const received: unknown[] = [];
  const onMention = (payload: unknown) => received.push(readRoomMentionCreatedEvent(payload));
  try {
    // Dispatching from a remote origin before attaching `onMention` must NOT report `unknown_notification_event`.
    await dispatchBridgeNotification({
      v: 1,
      lane: "room-mentions",
      event: ROOM_MENTION_CREATED,
      mode: "inline",
      origin: "remote-instance",
      data: {
        projectId: "focus_103",
        roomDisplayName: "Focus: Features",
        messageId: "msg_9",
        threadRootId: null,
        targetAccountIds: ["acct_1"],
        publisherAccountId: null,
      },
    });
    assert.deepEqual(losses, []);

    roomMentionEvents.on(ROOM_MENTION_CREATED, onMention);
    announceRoomMentionCreated({
      projectId: "focus_103",
      roomDisplayName: "Focus: Features",
      messageId: "msg_15",
      threadRootId: "msg_9",
      targetAccountIds: ["acct_1", "acct_1"],
      publisherAccountId: null,
    });
    assert.equal(received.length, 1);
    const parsed = received[0]!;
    assert.deepEqual(roomMentionStreamPayload(parsed as never), {
      room_id: "focus_103",
      room_display_name: "Focus: Features",
      message_id: "msg_15",
      thread_root_id: "msg_9",
    });
    assert.deepEqual(
      parseRoomMentionEvent(roomMentionStreamPayload(parsed as never)),
      {
        room_id: "focus_103",
        room_display_name: "Focus: Features",
        message_id: "msg_15",
        thread_root_id: "msg_9",
      },
    );
    assert.equal(parseRoomMentionEvent({ room_id: "focus_103", message_id: "not-a-msg" }), null);
  } finally {
    roomMentionEvents.off(ROOM_MENTION_CREATED, onMention);
    roomEventBridgeLossEvents.off("loss", onLoss);
  }
});

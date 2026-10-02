import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveExternalWebHref } from "../src/components/desktop/content/desktop-chat-message/message-links";
import {
  LETAGENTS_ROOM_ORIGIN,
  MESSAGE_ID_PATTERN,
  isValidMessageId,
  encodeRoomPathIdentifier,
  decodeRoomPath,
  isLocalRoomIdentifier,
  buildLetAgentsMessageUrl,
  parseLetAgentsMessageUrl,
} from "../src/domain/room-urls";

const BASE = "http://localhost:5174/room/abc";

describe("resolveExternalWebHref", () => {
  it("returns absolute http/https links unchanged (normalized)", () => {
    assert.equal(resolveExternalWebHref("https://example.com/x", BASE), "https://example.com/x");
    assert.equal(resolveExternalWebHref("http://example.com", BASE), "http://example.com/");
  });

  it("rejects non-web schemes on absolute hrefs", () => {
    assert.equal(resolveExternalWebHref("mailto:a@b.com", BASE), null);
    assert.equal(resolveExternalWebHref("javascript:alert(1)", BASE), null);
    assert.equal(resolveExternalWebHref("file:///etc/passwd", BASE), null);
    assert.equal(resolveExternalWebHref("custom-scheme://do-thing", BASE), null);
  });

  it("treats missing/empty hrefs as no link", () => {
    assert.equal(resolveExternalWebHref(null, BASE), null);
    assert.equal(resolveExternalWebHref(undefined, BASE), null);
    assert.equal(resolveExternalWebHref("", BASE), null);
  });

  it("preserves query and fragment", () => {
    assert.equal(
      resolveExternalWebHref("https://example.com/p?q=1#frag", BASE),
      "https://example.com/p?q=1#frag",
    );
  });
});

describe("isValidMessageId", () => {
  const validIds = ["msg_1", "msg_2", "msg_42", "msg_12345", "msg_999999999"];
  for (const id of validIds) {
    it(`accepts valid message id: ${id}`, () => {
      assert.equal(isValidMessageId(id), true);
      assert.equal(MESSAGE_ID_PATTERN.test(id), true);
    });
  }

  const invalidIds = [
    "",
    "   ",
    "msg_0",
    "msg_01",
    "msg_00",
    "msg_",
    "msg_-1",
    "msg_abc",
    "msg_12a",
    "task_1",
    "123",
    "msg_1<script>",
    "msg_1?foo=bar",
    "msg_1#hash",
    "msg_ 1",
    "msg_1 ",
    " msg_1",
    null,
    undefined,
    123,
    {},
  ];
  for (const id of invalidIds) {
    it(`rejects invalid message id: ${JSON.stringify(id)}`, () => {
      assert.equal(isValidMessageId(id), false);
    });
  }
});

describe("isLocalRoomIdentifier", () => {
  it("identifies local and git-room:local identifiers", () => {
    assert.equal(isLocalRoomIdentifier("local-123"), true);
    assert.equal(isLocalRoomIdentifier("local_test"), true);
    assert.equal(isLocalRoomIdentifier("git-room:local:abc"), true);
    assert.equal(isLocalRoomIdentifier("github.com/BrosInCode/letagents"), false);
    assert.equal(isLocalRoomIdentifier("focus_90"), false);
    assert.equal(isLocalRoomIdentifier(null), false);
    assert.equal(isLocalRoomIdentifier(""), false);
  });
});

describe("buildLetAgentsMessageUrl and parseLetAgentsMessageUrl test table", () => {
  const testTable: Array<{
    description: string;
    roomIdentifier: string;
    messageId: string;
    origin?: string;
    expectedUrl: string;
  }> = [
    {
      description: "standard room identifier",
      roomIdentifier: "focus_90",
      messageId: "msg_157",
      expectedUrl: "https://letagents.chat/in/focus_90?message=msg_157",
    },
    {
      description: "room identifier with slashes",
      roomIdentifier: "github.com/BrosInCode/letagents",
      messageId: "msg_42",
      expectedUrl: "https://letagents.chat/in/github.com/BrosInCode/letagents?message=msg_42",
    },
    {
      description: "room identifier with spaces and hash characters",
      roomIdentifier: "github.com/Bros In Code/letagents#staging",
      messageId: "msg_1",
      expectedUrl: "https://letagents.chat/in/github.com/Bros%20In%20Code/letagents%23staging?message=msg_1",
    },
    {
      description: "room identifier with special encoded characters",
      roomIdentifier: "team/room@special+1",
      messageId: "msg_999",
      expectedUrl: "https://letagents.chat/in/team/room%40special%2B1?message=msg_999",
    },
    {
      description: "custom configured origin with port",
      roomIdentifier: "my-room",
      messageId: "msg_5",
      origin: "http://localhost:5173",
      expectedUrl: "http://localhost:5173/in/my-room?message=msg_5",
    },
    {
      description: "custom configured origin with trailing slash",
      roomIdentifier: "my-room",
      messageId: "msg_5",
      origin: "https://staging.letagents.chat/",
      expectedUrl: "https://staging.letagents.chat/in/my-room?message=msg_5",
    },
  ];

  for (const entry of testTable) {
    it(`builds and parses correctly: ${entry.description}`, () => {
      const url = buildLetAgentsMessageUrl(entry.roomIdentifier, entry.messageId, entry.origin);
      assert.equal(url, entry.expectedUrl);

      const parsed = parseLetAgentsMessageUrl(url, entry.origin);
      assert.notEqual(parsed, null);
      assert.equal(parsed?.roomIdentifier, entry.roomIdentifier);
      assert.equal(parsed?.messageId, entry.messageId);
    });
  }

  it("throws when building a URL with an invalid message ID", () => {
    assert.throws(() => buildLetAgentsMessageUrl("room1", "msg_0"), /Invalid message ID/);
    assert.throws(() => buildLetAgentsMessageUrl("room1", "invalid"), /Invalid message ID/);
    assert.throws(() => buildLetAgentsMessageUrl("room1", ""), /Invalid message ID/);
  });

  it("throws when building a URL with an empty room identifier", () => {
    assert.throws(() => buildLetAgentsMessageUrl("", "msg_1"), /Room identifier is required/);
    assert.throws(() => buildLetAgentsMessageUrl("   ", "msg_1"), /Room identifier is required/);
  });

  it("parses relative /in/... paths", () => {
    const parsed = parseLetAgentsMessageUrl("/in/focus_90?message=msg_123");
    assert.deepEqual(parsed, {
      roomIdentifier: "focus_90",
      messageId: "msg_123",
    });
  });

  it("parses room path with no message query parameter", () => {
    const parsed = parseLetAgentsMessageUrl("https://letagents.chat/in/focus_90");
    assert.deepEqual(parsed, {
      roomIdentifier: "focus_90",
      messageId: null,
    });
  });

  it("ignores non-standard query parameter ?m=msg_123 (one URL form only)", () => {
    const parsed = parseLetAgentsMessageUrl("https://letagents.chat/in/focus_90?m=msg_123");
    assert.deepEqual(parsed, {
      roomIdentifier: "focus_90",
      messageId: null,
    });
  });

  it("ignores hash aliases like #msg_123", () => {
    const parsed = parseLetAgentsMessageUrl("https://letagents.chat/in/focus_90#msg_123");
    assert.deepEqual(parsed, {
      roomIdentifier: "focus_90",
      messageId: null,
    });
  });

  it("ignores invalid message IDs in ?message query parameter", () => {
    const parsed = parseLetAgentsMessageUrl("https://letagents.chat/in/focus_90?message=invalid_id");
    assert.deepEqual(parsed, {
      roomIdentifier: "focus_90",
      messageId: null,
    });
  });

  it("preserves message id when other query parameters are present", () => {
    const parsed = parseLetAgentsMessageUrl("https://letagents.chat/in/focus_90?tab=chat&message=msg_42&foo=bar");
    assert.deepEqual(parsed, {
      roomIdentifier: "focus_90",
      messageId: "msg_42",
    });
  });

  it("rejects foreign origins (binding point 4 and 8)", () => {
    assert.equal(
      parseLetAgentsMessageUrl("https://evil.com/in/focus_90?message=msg_1", LETAGENTS_ROOM_ORIGIN),
      null,
    );
    assert.equal(
      parseLetAgentsMessageUrl("https://other-domain.org/in/room1?message=msg_1", "https://letagents.chat"),
      null,
    );
    assert.equal(
      parseLetAgentsMessageUrl("http://localhost:3000/in/room1?message=msg_1", "https://letagents.chat"),
      null,
    );
  });

  it("rejects non-room URLs", () => {
    assert.equal(parseLetAgentsMessageUrl("https://letagents.chat/about"), null);
    assert.equal(parseLetAgentsMessageUrl("https://letagents.chat/"), null);
    assert.equal(parseLetAgentsMessageUrl("https://letagents.chat/in/"), null);
    assert.equal(parseLetAgentsMessageUrl("not a url"), null);
    assert.equal(parseLetAgentsMessageUrl(""), null);
  });
});

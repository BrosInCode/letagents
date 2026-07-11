import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildMessageContextMenuGroups } from "../src/components/desktop/content/desktop-chat-message/context-menu";

function ids(groups: ReturnType<typeof buildMessageContextMenuGroups>): string[] {
  return groups.flat().map((item) => item.id);
}

describe("message context menu groups", () => {
  it("shows only the message group when no link was right-clicked", () => {
    const groups = buildMessageContextMenuGroups(null);
    assert.equal(groups.length, 1);
    assert.deepEqual(ids(groups), ["copy-message", "quote-reply", "reply-in-thread"]);
  });

  it("prepends a link group when a link was right-clicked", () => {
    const groups = buildMessageContextMenuGroups("https://example.com/x");
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].map((item) => item.id), ["open-link", "copy-link"]);
    assert.deepEqual(ids(groups), [
      "open-link",
      "copy-link",
      "copy-message",
      "quote-reply",
      "reply-in-thread",
    ]);
  });
});

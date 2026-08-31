import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  maxThreadPaneWidthForContainer,
  shouldOverlayThreadPane,
} from "../src/components/desktop/content/room-chat/thread-layout";

const threadStyles = readFileSync(new URL("../src/styles/message-content/thread-panel.css", import.meta.url), "utf8");

describe("desktop thread layout", () => {
  it("uses an overlay when the chat container cannot fit both panes", () => {
    assert.equal(shouldOverlayThreadPane(788), true);
    assert.equal(shouldOverlayThreadPane(889), true);
    assert.equal(shouldOverlayThreadPane(890), false);
  });

  it("sizes the thread pane from its chat container rather than the window", () => {
    assert.equal(maxThreadPaneWidthForContainer(950), 380);
    assert.equal(maxThreadPaneWidthForContainer(1_200), 560);
  });

  it("bounds the message grid without clipping horizontally scrollable code blocks", () => {
    const contentRule = threadStyles.match(/\.room-thread-panel \.room-chat-message\.is-thread-context \.room-chat-message-content\s*\{([^}]*)\}/)?.[1] || "";
    assert.match(contentRule, /grid-template-columns:\s*minmax\(0, 1fr\);/);
    assert.doesNotMatch(threadStyles, /overflow-x:\s*(?:hidden|clip);/);
    const readerStyles = readFileSync(new URL("../src/styles/message-content/long-message-reader.css", import.meta.url), "utf8");
    const codeRule = readerStyles.match(/\.desktop-long-message-html :is\(pre\)\s*\{([^}]*)\}/)?.[1] || "";
    assert.match(codeRule, /overflow-x:\s*auto;/);
  });

  it("lets thread sender groups shrink so their existing ellipsis can take effect", () => {
    const authorRule = threadStyles.match(/\.room-thread-panel \.room-chat-message\.is-thread-context \.room-message-author-block\s*\{([^}]*)\}/)?.[1] || "";
    assert.match(authorRule, /min-width:\s*0;/);
    assert.match(authorRule, /max-width:\s*100%;/);
  });

  it("wraps long quoted text and sender labels within the thread reply preview", () => {
    const quoteRule = threadStyles.match(/\.room-thread-panel \.room-chat-message\.is-thread-context \.room-message-reply\s*\{([^}]*)\}/)?.[1] || "";
    assert.match(quoteRule, /grid-template-columns:\s*minmax\(0, 1fr\);/);
    assert.match(quoteRule, /min-width:\s*0;/);
    assert.match(quoteRule, /overflow-wrap:\s*anywhere;/);
  });
});

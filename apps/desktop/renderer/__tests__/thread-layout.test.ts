import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const styles = readFileSync(new URL("../src/styles/message-content/thread-panel.css", import.meta.url), "utf8");
const view = readFileSync(new URL("../src/components/desktop/content/RoomChatView.vue", import.meta.url), "utf8");
const message = readFileSync(new URL("../src/components/desktop/content/DesktopChatMessage.vue", import.meta.url), "utf8");

describe("inline room thread layout", () => {
  it("keeps the reply surface inside the owner bubble with no modal or resize pane", () => {
    assert.match(view, /<template #thread>[\s\S]*<RoomThreadPanel/);
    assert.doesNotMatch(view, /room-thread-backdrop|room-thread-resize-handle|threadPaneOverlay/);
    const bubble = message.slice(message.indexOf('<div class="room-message-bubble">'), message.indexOf('<MessageReactionBar'));
    assert.match(bubble, /aria-expanded="activeThreadRoot"/);
    assert.match(bubble, /<slot name="thread"/);
  });
  it("contains wheel chaining within a bounded, focusable reply scroller", () => {
    const body = styles.match(/\.room-thread-body\s*\{([^}]*)\}/)?.[1] || "";
    assert.match(body, /max-height:\s*clamp\(/);
    assert.match(body, /overflow-y:\s*auto/);
    assert.match(body, /overscroll-behavior:\s*contain/);
    assert.match(body, /overflow-anchor:\s*none/);
    const panel = readFileSync(new URL("../src/components/desktop/content/room-chat/RoomThreadPanel.vue", import.meta.url), "utf8");
    assert.match(panel, /class="room-thread-body" tabindex="0" aria-label="Thread replies"/);
    assert.doesNotMatch(panel, /context="thread-root"/);
  });
  it("keeps the latest-replies control outside the reading area", () => {
    const panel = readFileSync(new URL("../src/components/desktop/content/room-chat/RoomThreadPanel.vue", import.meta.url), "utf8");
    assert.ok(panel.indexOf('class="room-thread-latest"') > panel.indexOf('class="room-thread-composer-footer"'));
    const latest = styles.match(/\.room-thread-latest\s*\{([^}]*)\}/)?.[1] || "";
    assert.doesNotMatch(latest, /position:\s*(absolute|fixed)/);
  });
  it("leaves horizontal code scrolling available and honors reduced motion", () => {
    assert.doesNotMatch(styles, /overflow-x:\s*(?:hidden|clip)/);
    const transition = readFileSync(new URL("../../../../shared/ui/ThreadTransition.vue", import.meta.url), "utf8");
    assert.match(transition, /prefers-reduced-motion: reduce/);
    const reader = readFileSync(new URL("../src/styles/message-content/long-message-reader.css", import.meta.url), "utf8");
    assert.match(reader, /overflow-x:\s*auto/);
  });
});

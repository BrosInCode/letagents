import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const chatMessage = source("../src/components/desktop/content/DesktopChatMessage.vue");
const viewport = source("../src/components/desktop/content/room-chat/RoomMessageViewport.vue");
const threadPanel = source("../src/components/desktop/content/room-chat/RoomThreadPanel.vue");
const chatView = source("../src/components/desktop/content/RoomChatView.vue");
const surface = source("../src/components/desktop/content/room-chat/RoomMessageInfoSurface.vue");
const styles = source("../src/styles/message-content/message-info-surface.css");

test("Message info appears in both context-menu variants below a separator", () => {
  const linkVariant = /Copy link<\/span>[\s\S]{0,200}?room-message-context-menu-separator[\s\S]{0,200}?Message info/;
  const messageVariant = /tertiaryActionLabel \}\}<\/span>[\s\S]{0,200}?room-message-context-menu-separator[\s\S]{0,200}?Message info/;
  assert.match(chatMessage, linkVariant);
  assert.match(chatMessage, messageVariant);
  assert.match(chatMessage, /"message-info": \[messageId: string, context: "timeline" \| "thread-root" \| "thread-reply"\];/);
  // Opening a surface is an action: invocation focus must not be restored
  // over it (shouldRestoreContextMenuFocus returns false for "action").
  assert.match(chatMessage, /function messageInfoFromContext[\s\S]{0,120}?closeContextMenu\("action"\)/);
});

test("the message-info event reaches RoomChatView from timeline and thread surfaces", () => {
  assert.match(viewport, /@message-info="\(messageId, context\) => \$emit\('message-info', messageId, context\)"/);
  assert.match(threadPanel, /@message-info="\(messageId, context\) => \$emit\('message-info', messageId, context\)"/);
  assert.match(chatView, /@message-info="openMessageInfo"/);
  assert.match(chatView, /<RoomMessageInfoSurface/);
});

test("the surface fetches through IPC and treats local rooms honestly", () => {
  assert.match(surface, /desktopIpc\.room\.getMessageInfo\(props\.roomIdentifier, props\.messageId\)/);
  assert.match(surface, /Message info is available in shared rooms/);
  assert.match(surface, /localOnly/);
});

test("the surface distinguishes observed evidence and never claims reads for agents", () => {
  assert.match(surface, /Observed · awaiting reply/);
  assert.match(surface, /Asked to respond · Not yet observed/);
  assert.doesNotMatch(surface, /Seen · awaiting reply/);
});

test("dismissal semantics: Escape restores focus, outside click never steals it", () => {
  assert.match(surface, /event\.key === "Escape"[\s\S]{0,80}?close\(true\)/);
  assert.match(surface, /handlePointerDown[\s\S]{0,300}?close\(false\)/);
  assert.match(surface, /document\.addEventListener\("keydown", handleKeydown, true\)/);
  assert.match(surface, /document\.addEventListener\("pointerdown", handlePointerDown, true\)/);
});

test("the overlay never displaces the room and respects reduced motion", () => {
  assert.match(styles, /\.room-message-info-surface \{[\s\S]{0,80}?position: fixed/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /prefers-reduced-transparency/);
  assert.match(styles, /@media \(max-width: 719px\)/);
});

test("a room or message-namespace change closes the surface instead of showing stale evidence", () => {
  assert.match(chatView, /watch\(\(\) => \[props\.roomIdentifier, props\.messageNamespace\] as const, \(\) => \{\s*messageInfoTargetId\.value = null;\s*\}\)/);
});

test("focus restoration survives the invoking menu item unmounting", () => {
  assert.match(surface, /restoreFocusElement\?\.isConnected/);
  // Desktop rows expose data-message-id (data-msg-id is the web app's attribute).
  assert.match(surface, /data-message-id="\$\{CSS\.escape\(props\.messageId\)\}"/);
  assert.doesNotMatch(surface, /data-msg-id/);
  assert.match(surface, /setAttribute\("tabindex", "-1"\)/);
});

test("focus fallback restores the invoking duplicate of a twice-rendered thread root", () => {
  // The emit chain carries the invoking context end to end...
  assert.match(chatMessage, /emit\("message-info", props\.message\.id, props\.context\)/);
  assert.match(viewport, /\(messageId, context\) => \$emit\('message-info', messageId, context\)/);
  assert.match(threadPanel, /\(messageId, context\) => \$emit\('message-info', messageId, context\)/);
  assert.match(chatView, /openMessageInfo\(messageId: string, context: "timeline" \| "thread-root" \| "thread-reply"\)/);
  // ...and the surface prefers the duplicate whose thread-context class
  // matches the invoker instead of the first document-order (timeline) row.
  assert.match(surface, /preferThreadRow = props\.invokerContext === "thread-root" \|\| props\.invokerContext === "thread-reply"/);
  assert.match(surface, /classList\.contains\("is-thread-context"\) === preferThreadRow/);
});

test("the dialog takes initial focus on open", () => {
  assert.match(surface, /nextTick\(\(\) => closeButton\.value\?\.focus\(\{ preventScroll: true \}\)\)/);
});

test("the menu position clamp accounts for the taller message variant", () => {
  assert.match(chatMessage, /const menuHeight = linkHref \? 140 : 176/);
  assert.doesNotMatch(chatMessage, /const menuHeight = 122/);
});

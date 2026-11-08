import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const chatMessage = source("../src/components/desktop/content/DesktopChatMessage.vue");
const chatView = source("../src/components/desktop/content/RoomChatView.vue");
const mark = source("../src/components/desktop/content/room-chat/RoomMessageReceiptMark.vue");
const popover = source("../src/components/desktop/content/room-chat/RoomMessageReceiptPopover.vue");
const store = source("../src/composables/useRoomMessageReceipts.ts");
const session = source("../src/composables/app/useAppSession.ts");
const styles = source("../src/styles/message-content/message-receipts.css");

test("receipts are for the sender only: the mark and Message info show on your own sent messages", () => {
  assert.match(chatMessage, /const showsReceipt = computed\(\(\) => senderRole\.value === "self"/);
  assert.match(chatMessage, /<time :datetime="message\.timestamp">\{\{ formattedTime \}\}<\/time>\s*<RoomMessageReceiptMark v-if="showsReceipt"/);
  const menuItems = chatMessage.match(/<template v-if="showsReceipt">\s*<div class="room-message-context-menu-separator" role="separator" \/>\s*<button type="button" role="menuitem" @click="messageInfoFromContext">/g) ?? [];
  assert.equal(menuItems.length, 2, "both context-menu variants gate Message info on the receipt");
  assert.match(chatMessage, /function messageInfoFromContext[\s\S]{0,160}?closeContextMenu\("action"\)[\s\S]{0,80}?receiptMark\.value\?\.open\(\)/);
});

test("the old Message info surface is gone and the receipt popover replaces it", () => {
  assert.doesNotMatch(chatView, /RoomMessageInfoSurface/);
  assert.match(chatView, /<RoomMessageReceiptPopover[\s\S]{0,400}?@ask="askFromReceipt"/);
  assert.match(chatView, /provideRoomMessageReceipts\(messageReceipts\)/);
});

test("Ask is a reply to your own message that mentions one agent", () => {
  assert.match(chatView, /function askFromReceipt[\s\S]{0,500}?emit\("send-message", target\.mention, messageId, \[\], threadRootId,/);
  assert.match(popover, /participant\.kind === "agent" && participant\.agentKey && !participant\.hiddenAt/);
});

test("receipts load in batches, refresh on the live Message info event, and reset per room", () => {
  assert.match(store, /const BATCH_LIMIT = 100;/);
  assert.match(store, /getMessageReceipts!\(room, ids\)/);
  assert.match(session, /event\.resource === "message_info"\) invalidateRoomMessageReceipts\(event\.roomIdentifier\)/);
  assert.match(session, /if \(event\.type === "open"\) \{[^}]*invalidateRoomMessageReceipts\(event\.roomIdentifier\)/);
  assert.match(store, /watch\(\(\) => normalizeRoomIdentifier\(roomIdentifier\.value\), \(\) => \{\s*generation \+= 1;/);
});

test("the mark and the popover controls keep a 44px target while they look small", () => {
  assert.match(styles, /\.room-receipt-mark::before \{ content: ""; position: absolute; inset: -11px -3px; \}/);
  assert.match(styles, /\.room-receipt-ask::before \{ content: ""; position: absolute; inset: -8px -4px; \}/);
  assert.match(styles, /\.room-receipt-foot \{[^}]*min-height: 44px/);
});

test("the popover grows out of its mark, is a labelled dialog, and closes with Escape back to the mark", () => {
  assert.match(popover, /role="dialog"\s+aria-labelledby="room-receipt-title"/);
  assert.match(popover, /transformOrigin: `\$\{Math\.round\(rect\.left \+ rect\.width \/ 2 - left\)\}px \$\{below \? "0" : "100%"\}`/);
  assert.match(popover, /@keydown\.esc\.stop\.prevent="close\(true\)"/);
  assert.match(popover, /if \(restoreFocus\) mark\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(mark, /:aria-label="`\$\{summary!\.title\}\. Show who this message woke`"/);
});

test("motion is short, only real changes animate, and reduced motion keeps a cross-fade", () => {
  assert.match(styles, /transition: opacity 180ms cubic-bezier\(0\.23, 1, 0\.32, 1\), transform 180ms/);
  assert.match(popover, /if \(!opened\.value \|\| !before \|\| title === before\) return;/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\.room-receipt-popover \{ transform: none; transition: opacity 120ms ease; \}/);
  assert.doesNotMatch(styles, /transition: all/);
});

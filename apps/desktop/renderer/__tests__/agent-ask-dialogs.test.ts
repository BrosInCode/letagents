import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../src/components/desktop/content/${path}`, import.meta.url)), "utf8");

test("a new room made by a failed ask is reused on retry, and forgotten when the sheet reopens", () => {
  const dialog = source("asks/AskAgentDialog.vue");
  assert.match(dialog, /if \(!createdRoomId\.value\) \{\s*const room = await desktopIpc\.room\.createInviteRoom\(\);/);
  assert.match(dialog, /roomId = createdRoomId\.value;/);
  assert.match(dialog, /createdRoomId\.value = null;/);
});

test("the composer's + menu closes on a click elsewhere or Escape, and drops its listeners on unmount", () => {
  const composer = source("room-chat/RoomComposer.vue");
  assert.match(composer, /ref="addMenuWrap"/);
  assert.match(composer, /document\[method\]\("pointerdown", closeAddMenuOnOutsidePointer as EventListener, true\)/);
  assert.match(composer, /document\[method\]\("keydown", closeAddMenuOnEscape as EventListener, true\)/);
  assert.match(composer, /document\.removeEventListener\("pointerdown", closeAddMenuOnOutsidePointer as EventListener, true\)/);
});

test("the giving screen shows why \"Can't right now\" did not go through, and stays open", () => {
  const give = source("asks/GiveAgentDialog.vue");
  assert.match(give, /if \(!result\?\.ok\) \{ error\.value = /);
});

test("the giving screen offers only models on the current list, never one built from the ask", () => {
  const give = source("asks/GiveAgentDialog.vue");
  assert.doesNotMatch(give, /label: preview\.value\.ask\.model_label/);
  assert.match(give, /model\.model === preview\.value\.ask\.model\) \?\? null;/);
});

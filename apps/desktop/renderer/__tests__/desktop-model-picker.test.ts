import assert from "node:assert/strict";
import test from "node:test";

import { modelPickerFocusLeft } from "../src/components/desktop/controls/model-picker-focus";

const option = {} as EventTarget;
const elsewhere = {} as EventTarget;
const insidePicker = (target: EventTarget) => target === option;

test("the model list stays open while the window, not the picker, loses focus", () => {
  // Switching apps or an automation tool taking focus: no next target and
  // the page itself is no longer focused. The open options must survive.
  assert.equal(modelPickerFocusLeft(null, insidePicker, false), false);
});

test("the model list closes when focus moves elsewhere on the page", () => {
  assert.equal(modelPickerFocusLeft(elsewhere, insidePicker, true), true);
  // A click on a non-focusable area of the page also has no next target.
  assert.equal(modelPickerFocusLeft(null, insidePicker, true), true);
  // Focus moving onto one of the picker's own options keeps it open.
  assert.equal(modelPickerFocusLeft(option, insidePicker, true), false);
});

test("the picker asks whether the page still has focus before closing", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/components/desktop/controls/DesktopModelPicker.vue", import.meta.url), "utf8");
  assert.match(source, /modelPickerFocusLeft\(\s*event\.relatedTarget,[\s\S]*?document\.hasFocus\(\),?\s*\)/);
});

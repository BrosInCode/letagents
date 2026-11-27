import assert from "node:assert/strict";
import test from "node:test";

import { backdropClose } from "../../../../shared/ui/board/dialog-backdrop";

const dialog = { getBoundingClientRect: () => ({ left: 800, right: 1360, top: 12, bottom: 900 }) } as unknown as HTMLDialogElement;
const inside = { target: {} };

function press(target: object, clientX: number, clientY = 400) {
  return { target, clientX, clientY } as unknown as PointerEvent;
}

test("a click on the backdrop closes the dialog", () => {
  let closed = 0;
  const backdrop = backdropClose(() => dialog, () => { closed += 1; });
  backdrop.pointerdown(press(dialog, 300));
  backdrop.click(press(dialog, 300));
  assert.equal(closed, 1);
});

test("a click inside the dialog box does not close it", () => {
  let closed = 0;
  const backdrop = backdropClose(() => dialog, () => { closed += 1; });
  backdrop.pointerdown(press(inside.target, 900));
  backdrop.click(press(inside.target, 900));
  backdrop.pointerdown(press(dialog, 900));
  backdrop.click(press(dialog, 900));
  assert.equal(closed, 0, "padding of the dialog itself is inside its box");
});

test("selecting text inside and letting go outside does not close it", () => {
  let closed = 0;
  const backdrop = backdropClose(() => dialog, () => { closed += 1; });
  backdrop.pointerdown(press(inside.target, 900));
  backdrop.click(press(dialog, 300));
  assert.equal(closed, 0);
});

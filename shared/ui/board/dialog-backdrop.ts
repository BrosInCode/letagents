/** A press on a modal <dialog> itself, outside its box: on the backdrop. */
function onBackdrop(event: MouseEvent, dialog: HTMLDialogElement | null | undefined): boolean {
  if (!dialog || event.target !== dialog) return false;
  const rect = dialog.getBoundingClientRect();
  return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
}

/**
 * Closes a modal board dialog when the person clicks outside it. Bind both
 * handlers on the <dialog>: `@pointerdown="x.pointerdown" @click="x.click"`.
 * The press must start on the backdrop too, so selecting text in a field and
 * letting go outside the dialog does not close it and lose the edit.
 */
export function backdropClose(dialog: () => HTMLDialogElement | null | undefined, close: () => void) {
  let pressedOnBackdrop = false;
  return {
    pointerdown(event: PointerEvent) { pressedOnBackdrop = onBackdrop(event, dialog()); },
    click(event: MouseEvent) {
      if (pressedOnBackdrop && onBackdrop(event, dialog())) close();
      pressedOnBackdrop = false;
    },
  };
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function currentFocusableElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

export function restoreFocus(element: HTMLElement | null): void {
  if (element && document.contains(element)) {
    element.focus({ preventScroll: true });
  }
}

export function focusFirstElementInDialog(dialog: HTMLElement | null): void {
  if (!dialog) return;
  const firstElement = focusableElementsInDialog(dialog)[0];
  (firstElement || dialog).focus({ preventScroll: true });
}

export function trapFocusInDialog(event: KeyboardEvent, dialog: HTMLElement | null): void {
  if (!dialog) {
    return;
  }

  const focusableElements = focusableElementsInDialog(dialog);
  if (!focusableElements.length) {
    event.preventDefault();
    dialog.focus({ preventScroll: true });
    return;
  }

  const firstElement = focusableElements[0];
  const lastElement = focusableElements[focusableElements.length - 1];
  const activeElement = currentFocusableElement();
  if (event.shiftKey && (
    !activeElement
    || !dialog.contains(activeElement)
    || activeElement === dialog
    || activeElement === firstElement
  )) {
    event.preventDefault();
    lastElement.focus({ preventScroll: true });
    return;
  }

  if (!event.shiftKey && activeElement === lastElement) {
    event.preventDefault();
    firstElement.focus({ preventScroll: true });
  }
}

function focusableElementsInDialog(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) =>
      !element.hasAttribute("disabled")
      && element.getAttribute("aria-hidden") !== "true"
      && element.getClientRects().length > 0
    );
}

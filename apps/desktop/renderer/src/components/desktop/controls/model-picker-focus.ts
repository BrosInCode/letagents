/**
 * Whether focus leaving the model picker means the person is done with it.
 *
 * Focus moving to another control on the page closes the list. The window
 * losing focus does not: switching apps, or an automation tool taking focus,
 * used to close the list and rebuild every option when focus came back, so a
 * press aimed at the option that had been on screen selected nothing.
 */
export function modelPickerFocusLeft(
  relatedTarget: EventTarget | null,
  contains: (target: EventTarget) => boolean,
  documentHasFocus: boolean,
): boolean {
  if (relatedTarget) return !contains(relatedTarget);
  return documentHasFocus;
}

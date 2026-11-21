/**
 * The text of the room message a prompt of the daemon is for.
 *
 * A prompt quotes other recent room messages too, so a search of the whole
 * prompt for a message text does not say which message it answers. Only its
 * "Source message" line does. The first prompt of a session is for no room
 * message: null.
 */
export function promptSourceText(prompt: string): string | null {
  const line = /^Source message: (.*)$/m.exec(prompt)?.[1];
  return line ? (JSON.parse(line) as { text: string }).text : null;
}

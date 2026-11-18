import type { WebContents } from "electron";

import {
  INLINE_HTML_DEMO_EVENT_BURST,
  INLINE_HTML_DEMO_EVENTS_PER_SECOND,
  INLINE_HTML_DEMO_TEXT_BURST,
  INLINE_HTML_DEMO_TEXT_PER_SECOND,
  inlineHtmlDemoBucket,
  inlineHtmlDemoEventText,
  takeInlineHtmlDemoTokens,
} from "./html-demo-policy.js";

/**
 * The guest events Electron 42 forwards to the `<webview>` element, each one a
 * message through main to the app page (lib/browser/web-view-events.ts).
 * A page can repeat most of them as fast as it likes.
 */
export const FORWARDED_GUEST_EVENTS = [
  "load-commit", "did-finish-load", "did-fail-load", "did-frame-finish-load", "did-start-loading",
  "did-stop-loading", "dom-ready", "console-message", "context-menu", "devtools-open-url",
  "devtools-opened", "devtools-closed", "devtools-focused", "will-navigate", "will-frame-navigate",
  "did-start-navigation", "did-redirect-navigation", "did-navigate", "did-frame-navigate",
  "did-navigate-in-page", "page-title-updated", "page-favicon-updated", "enter-html-full-screen",
  "leave-html-full-screen", "media-started-playing", "media-paused", "found-in-page",
  "did-change-theme-color", "update-target-url", "-focus-change",
] as const;

/**
 * Count what a guest makes Electron forward to its `<webview>`, in the demo
 * token buckets, and call `onFlood` once either runs dry. Demos and room pages
 * share the limits: both run a page someone else wrote inside the app window.
 */
export function watchGuestEventFlood(guest: WebContents, stopped: () => boolean, onFlood: () => void): void {
  const emitter: NodeJS.EventEmitter = guest;
  const boundAt = Date.now();
  const events = inlineHtmlDemoBucket(INLINE_HTML_DEMO_EVENT_BURST, INLINE_HTML_DEMO_EVENTS_PER_SECOND, boundAt);
  const text = inlineHtmlDemoBucket(INLINE_HTML_DEMO_TEXT_BURST, INLINE_HTML_DEMO_TEXT_PER_SECOND, boundAt);
  const countEvent = (...args: unknown[]) => {
    if (stopped()) return;
    const now = Date.now();
    const eventsLeft = takeInlineHtmlDemoTokens(events, 1, now);
    const textLeft = takeInlineHtmlDemoTokens(text, inlineHtmlDemoEventText(args), now);
    if (!eventsLeft || !textLeft) onFlood();
  };
  for (const name of FORWARDED_GUEST_EVENTS) emitter.on(name, countEvent);
}

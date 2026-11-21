import type { Session } from "electron";

import { prepareLockedHtmlSession } from "../attachments/html-demo-session.js";
import { pageProtocolScheme } from "#provider-runtime/paths.js";
import { PAGE_PARTITION } from "./page-policy.js";

/** Page documents by host; a host exists only while its lease is live. */
export const roomPageDocuments = new Map<string, string>();
/** The page guests' own web contents and the host each one shows. */
export const roomPageContents = new Map<number, string>();
let pageSession: Promise<Session> | null = null;

/** The page session, with the same locks as the demo session, set up once. */
export function roomPageSession(): Promise<Session> {
  // A failed setup is not cached, so the next open tries again.
  pageSession ??= prepareLockedHtmlSession({
    partition: PAGE_PARTITION,
    scheme: pageProtocolScheme,
    documents: roomPageDocuments,
    contents: roomPageContents,
    closedText: "This page is closed.",
    networkBlockError: "Room pages cannot open because their network block could not be set up.",
  }).catch((error: unknown) => {
    pageSession = null;
    throw error;
  });
  return pageSession;
}

import express, { type Request, type Response } from "express";

import { ApiError } from "../../../shared/api/core.mjs";
import { parseBearerAuthorization } from "../request/bearer-authorization.js";
import { parseCookies } from "./helpers.js";

/** POST /api/v1/rooms/:room/pages and /api/v1/rooms/:room/pages/:pageId/versions. */
const PAGE_HTML_BODY_PATH = /^\/api\/v1\/rooms\/[^/]+\/pages(?:\/[^/]+\/versions)?\/?$/;

/** What the global parser reads from anyone, signed in or not. */
export const DEFAULT_JSON_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * A room page's HTML is up to 2 MB, sent as a JSON string. Quotes, newlines
 * and backslashes take two bytes once escaped, and a client that escapes
 * non-ASCII (Python's json.dumps does by default) sends a CJK character's
 * three bytes as six. Twice the HTML, plus room for the other fields.
 */
export const PAGE_HTML_BODY_LIMIT_BYTES = 5 * 1024 * 1024;

const DEFERRED = Symbol("letagents.deferredPageHtmlBody");
type DeferrableRequest = Request & { [DEFERRED]?: boolean };

const pageHtmlJson = express.json({ limit: PAGE_HTML_BODY_LIMIT_BYTES });

/** Whether this request's body waits for the /api/v1 pipeline to know the caller. */
export function isPageHtmlBodyRequest(req: Pick<Request, "method" | "path">): boolean {
  return req.method === "POST" && PAGE_HTML_BODY_PATH.test(req.path);
}

/** Leaves the body unread until the caller is known (see readDeferredPageHtmlBody). */
export function deferPageHtmlBody(req: Request): void {
  (req as DeferrableRequest)[DEFERRED] = true;
}

/**
 * A body larger than anyone may send without signing in, from a request with
 * no credential at all: refused from its Content-Length alone. A request
 * with a credential still waits for the pipeline, which refuses a bad one
 * before reading.
 */
export function isOversizedAnonymousBody(req: Request): boolean {
  const length = Number(req.headers["content-length"]);
  if (!Number.isFinite(length) || length <= DEFAULT_JSON_BODY_LIMIT_BYTES) return false;
  if (parseBearerAuthorization(req.headers.authorization).kind !== "none") return false;
  return !parseCookies(req.headers.cookie).letagents_session;
}

/**
 * Called on every refusal: when a deferred body was never read, the
 * connection closes after the answer instead of reading the rest to reuse it.
 */
export function closeIfBodyUnread(req: Request, res: Response): void {
  if ((req as DeferrableRequest)[DEFERRED] && !res.headersSent) res.setHeader("Connection", "close");
}

/**
 * Reads a deferred page body (up to PAGE_HTML_BODY_LIMIT_BYTES) once the
 * caller is known. Returns false when this request had no deferred body.
 */
export async function readDeferredPageHtmlBody(req: Request, res: Response): Promise<boolean> {
  const request = req as DeferrableRequest;
  if (!request[DEFERRED]) return false;
  await new Promise<void>((resolve, reject) => {
    pageHtmlJson(req, res, (error?: unknown) => (error ? reject(error) : resolve()));
  }).catch((error: unknown) => {
    const type = (error as { type?: string } | null)?.type;
    if (type === "entity.too.large") throw new ApiError("too_large", "The request body is too large.");
    if (type === "entity.parse.failed") throw new ApiError("invalid_input", "The request body is not valid JSON.");
    throw error;
  });
  request[DEFERRED] = false;
  return true;
}

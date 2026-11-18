import express, { type Express, type NextFunction, type Request, type Response } from "express";

import { actorKey } from "../../../shared/api/actor.mjs";
import { ApiError, capabilityForCall, describeIssues, methodMayReturn, type AnyApiMethod } from "../../../shared/api/core.mjs";
import { GitHubAccessUnavailableError } from "../github/repo-access.js";
import type { AuthenticatedRequest } from "../http/helpers.js";
import { closeIfBodyUnread, readDeferredPageHtmlBody } from "../http/page-html-body.js";
import { apiActionTarget, recordApiAction, type ApiActionRecord } from "./actions.js";
import { identifyCaller, resolveRoomAccess } from "./actor.js";
import { API_V1_ROUTES } from "./areas.js";
import { checkCapability } from "./capability.js";
import type { ApiCallContext, ApiCallerIdentifier, ApiCapabilityCheck, ApiRoomAccessResolver } from "./context.js";
import { createApiRateLimiter, type ApiRateLimiter } from "./rate-limit.js";
import { ApiStatusResponse, type ApiRoute } from "./route.js";

export const API_V1_PREFIX = "/api/v1";

export interface ApiV1RouterDeps {
  routes?: readonly ApiRoute[];
  identifyCaller?: ApiCallerIdentifier;
  resolveRoomAccess?: ApiRoomAccessResolver;
  checkCapability?: ApiCapabilityCheck;
  rateLimiter?: ApiRateLimiter;
  /** Appends a write, intent or job to `api_actions`. */
  recordAction?: (record: ApiActionRecord) => Promise<void>;
  /**
   * On by default outside production: a handler error code the method does
   * not list becomes `internal`, so the mismatch shows in tests. Output that
   * does not parse is `internal` everywhere (fail closed), logged as a
   * contract mismatch.
   */
  strictContract?: boolean;
}

const GITHUB_RETRY_AFTER_MS = 30_000;
const INTERNAL_MESSAGE = "The server could not complete this call. Please retry.";

export function createApiV1Router(deps: ApiV1RouterDeps = {}): express.Router {
  const routes = deps.routes ?? API_V1_ROUTES;
  const identify = deps.identifyCaller ?? identifyCaller;
  const roomAccess = deps.resolveRoomAccess ?? resolveRoomAccess;
  const capabilityCheck = deps.checkCapability ?? checkCapability;
  const rateLimiter = deps.rateLimiter ?? createApiRateLimiter();
  const recordAction = deps.recordAction ?? recordApiAction;
  const strict = deps.strictContract ?? process.env.NODE_ENV !== "production";
  const router = express.Router();

  // A lost audit row must not turn a done write into a reported failure.
  const record = async (entry: ApiActionRecord) => {
    try {
      await recordAction(entry);
    } catch (error) {
      console.error(`[api v1 ${entry.method}] could not record the action`, error);
    }
  };

  for (const route of routes) {
    const verb = route.method.httpMethod.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
    router[verb](route.method.path, async (req: AuthenticatedRequest, res: Response) => {
      const { method } = route;
      // Only the handler's own refusals must be listed in the contract; the
      // pipeline's (caller, limit, room, input, capability) are common to every method.
      let inHandler = false;
      // Set once a write, intent or job passed the rate limit and the room
      // check: from then on its outcome is recorded, refusals included.
      let recordable: Omit<ApiActionRecord, "outcome" | "target"> | null = null;
      const { room: roomParam, ...pathParams } = req.params as Record<string, string>;
      try {
        // Who, then the limit, before any room or database work, so a
        // flood costs one lookup per call.
        let caller = await identify(req);
        if (!caller) throw new ApiError("unauthenticated", "Sign in to LetAgents to use the API.");
        const rate = rateLimiter.take(actorKey(caller), method.rateClass);
        if (!rate.allowed) {
          throw new ApiError("rate_limited", "Too many calls. Wait and try again.", { retryAfterMs: rate.retryAfterMs });
        }
        // A page's large HTML body is read only now (see page-html-body.ts).
        // The caller is identified again: body fields can mark a session's
        // call as not made in person.
        if (await readDeferredPageHtmlBody(req, res)) {
          caller = await identify(req);
          if (!caller) throw new ApiError("unauthenticated", "Sign in to LetAgents to use the API.");
        }
        const call: ApiCallContext = { ...(await roomAccess(caller, roomParam ?? "")), account: caller.account, req };
        if (method.kind !== "read") recordable = { actor: call.actor, method: method.name, capability: method.capability };
        const parsed = method.input.safeParse({ ...readInput(method, req), ...pathParams });
        if (!parsed.success) {
          throw new ApiError("invalid_input", describeIssues(parsed.error).map(({ path, message }) => (path ? `${path}: ${message}` : message)).join("; "));
        }
        // The capability this input needs (a document's scope, an intent's kind) is what the record names.
        if (recordable) recordable.capability = capabilityForCall(method, parsed.data);
        await capabilityCheck(call.actor, method, parsed.data, call);

        inHandler = true;
        if (route.kind === "stream") {
          await route.handler(parsed.data, call, res);
          if (recordable) await record({ ...recordable, target: actionTarget(req, pathParams), outcome: "ok" });
          return;
        }
        const result = await route.handler(parsed.data, call);
        const [status, body] = result instanceof ApiStatusResponse ? [result.status, result.body] : [200, result];
        // Always the parsed output: fields the schema does not name never leave the server.
        const checked = method.output.safeParse(body);
        if (!checked.success) {
          throw new Error(`Contract mismatch: ${method.name} returned output that does not match its contract: ${JSON.stringify(describeIssues(checked.error))}`);
        }
        if (recordable) await record({ ...recordable, target: actionTarget(req, pathParams), outcome: "ok" });
        res.status(status).json(checked.data);
      } catch (error) {
        if (res.headersSent) {
          // A stream already started: nothing to answer with but the end.
          console.error(`[api v1 ${method.name}] failed after the response started`, error);
          if (recordable) await record({ ...recordable, target: actionTarget(req, pathParams), outcome: "internal" });
          res.end();
          return;
        }
        closeIfBodyUnread(req, res);
        const apiError = toApiError(error, method, strict && inHandler);
        if (recordable) await record({ ...recordable, target: actionTarget(req, pathParams), outcome: apiError.code });
        replyApiError(res, apiError);
      }
    });
  }

  router.use((req, res) => {
    closeIfBodyUnread(req, res);
    replyApiError(res, new ApiError("not_found", `No LetAgents API method answers ${req.method} ${API_V1_PREFIX}${req.path}.`));
  });
  return router;
}

/**
 * Mounts the API under /api/v1, after the shared auth middleware. The error
 * handler answers body parse failures (bad JSON, too large) in the API's
 * error shape instead of Express's HTML page.
 */
export function registerApiV1Routes(app: Express, deps: ApiV1RouterDeps = {}): void {
  app.use(API_V1_PREFIX, createApiV1Router(deps));
  app.use(API_V1_PREFIX, (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    const type = (error as { type?: string } | null)?.type;
    if (type === "entity.parse.failed") return replyApiError(res, new ApiError("invalid_input", "The request body is not valid JSON."));
    if (type === "entity.too.large") return replyApiError(res, new ApiError("too_large", "The request body is too large."));
    console.error("[api v1]", error);
    replyApiError(res, new ApiError("internal", INTERNAL_MESSAGE));
  });
}

/** The handler's own target, else the path parameters after the room (`taskId=task_7`). */
function actionTarget(req: Request, pathParams: Record<string, string>): string | null {
  const own = apiActionTarget(req);
  if (own) return own;
  const params = Object.entries(pathParams).map(([key, value]) => `${key}=${value}`);
  return params.length ? params.join("&").slice(0, 500) : null;
}

function readInput(method: AnyApiMethod, req: Request): Record<string, unknown> {
  if (method.httpMethod === "GET" || method.httpMethod === "DELETE") return { ...(req.query as Record<string, unknown>) };
  const body: unknown = req.body ?? {};
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("invalid_input", "The request body must be a JSON object.");
  }
  return { ...(body as Record<string, unknown>) };
}

function toApiError(error: unknown, method: AnyApiMethod, strict: boolean): ApiError {
  if (error instanceof ApiError) {
    if (!strict || methodMayReturn(method, error.code)) return error;
    console.error(`[api v1 ${method.name}] contract mismatch: the handler threw "${error.code}", which the contract does not list.`, error);
    return new ApiError("internal", INTERNAL_MESSAGE);
  }
  if (error instanceof GitHubAccessUnavailableError) {
    return new ApiError("source_unavailable", "GitHub did not answer. Try again shortly.", { retryAfterMs: GITHUB_RETRY_AFTER_MS });
  }
  console.error(`[api v1 ${method.name}]`, error);
  return new ApiError("internal", INTERNAL_MESSAGE);
}

export function replyApiError(res: Response, error: ApiError): void {
  if (error.retryAfterMs !== undefined) res.setHeader("Retry-After", String(Math.ceil(error.retryAfterMs / 1000)));
  res.status(error.status).json(error.toBody());
}

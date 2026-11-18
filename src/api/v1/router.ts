import express, { type Express, type NextFunction, type Request, type Response } from "express";

import { actorKey } from "../../../shared/api/actor.mjs";
import { ApiError, describeIssues, methodMayReturn, type AnyApiMethod } from "../../../shared/api/core.mjs";
import { GitHubAccessUnavailableError } from "../github/repo-access.js";
import type { AuthenticatedRequest } from "../http/helpers.js";
import { resolveApiActor } from "./actor.js";
import { API_V1_ROUTES } from "./areas.js";
import { checkCapability } from "./capability.js";
import type { ApiActorResolver, ApiCapabilityCheck } from "./context.js";
import { createApiRateLimiter, type ApiRateLimiter } from "./rate-limit.js";
import type { ApiRoute } from "./route.js";

export const API_V1_PREFIX = "/api/v1";

export interface ApiV1RouterDeps {
  routes?: readonly ApiRoute[];
  resolveActor?: ApiActorResolver;
  checkCapability?: ApiCapabilityCheck;
  rateLimiter?: ApiRateLimiter;
  /** Check each output against its schema. On by default outside production, where a mismatch is a bug to see early. */
  checkOutput?: boolean;
}

const GITHUB_RETRY_AFTER_MS = 30_000;

export function createApiV1Router(deps: ApiV1RouterDeps = {}): express.Router {
  const routes = deps.routes ?? API_V1_ROUTES;
  const resolveActor = deps.resolveActor ?? resolveApiActor;
  const capabilityCheck = deps.checkCapability ?? checkCapability;
  const rateLimiter = deps.rateLimiter ?? createApiRateLimiter();
  const checkOutput = deps.checkOutput ?? process.env.NODE_ENV !== "production";
  const router = express.Router();

  for (const route of routes) {
    const verb = route.method.httpMethod.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
    router[verb](route.method.path, async (req: AuthenticatedRequest, res: Response) => {
      const { method } = route;
      // Only the handler's own refusals must be listed in the contract; the
      // pipeline's (room, capability, limit, input) are common to every method.
      let inHandler = false;
      try {
        const { room: roomParam, ...pathParams } = req.params as Record<string, string>;
        const call = { ...(await resolveActor(req, roomParam ?? "")), req };
        await capabilityCheck(call.actor, method.capability, call);
        const rate = rateLimiter.take(actorKey(call.actor), method.rateClass);
        if (!rate.allowed) {
          throw new ApiError("rate_limited", "Too many calls. Wait and try again.", { retryAfterMs: rate.retryAfterMs });
        }
        const parsed = method.input.safeParse({ ...readInput(method, req), ...pathParams });
        if (!parsed.success) {
          throw new ApiError("invalid_input", describeIssues(parsed.error).map(({ path, message }) => (path ? `${path}: ${message}` : message)).join("; "));
        }
        inHandler = true;
        const output = await route.handler(parsed.data, call);
        if (checkOutput) {
          const checked = method.output.safeParse(output);
          if (!checked.success) {
            throw new Error(`${method.name} returned output that does not match its contract: ${JSON.stringify(describeIssues(checked.error))}`);
          }
        }
        res.status(200).json(output);
      } catch (error) {
        replyApiError(res, toApiError(error, method, checkOutput && inHandler));
      }
    });
  }

  router.use((req, res) => {
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
    replyApiError(res, new ApiError("internal", "The server could not complete this call. Please retry."));
  });
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
    console.error(`[api v1 ${method.name}] the handler threw "${error.code}", which the contract does not list.`, error);
    return new ApiError("internal", "The server could not complete this call. Please retry.");
  }
  if (error instanceof GitHubAccessUnavailableError) {
    return new ApiError("source_unavailable", "GitHub did not answer. Try again shortly.", { retryAfterMs: GITHUB_RETRY_AFTER_MS });
  }
  console.error(`[api v1 ${method.name}]`, error);
  return new ApiError("internal", "The server could not complete this call. Please retry.");
}

export function replyApiError(res: Response, error: ApiError): void {
  if (error.retryAfterMs !== undefined) res.setHeader("Retry-After", String(Math.ceil(error.retryAfterMs / 1000)));
  res.status(error.status).json(error.toBody());
}

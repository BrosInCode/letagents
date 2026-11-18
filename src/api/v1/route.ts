import type { Response } from "express";
import type { z } from "zod";

import type { AnyApiMethod } from "../../../shared/api/core.mjs";
import type { ApiCallContext } from "./context.js";

/**
 * A JSON answer with a status other than 200. Only 201 and 202: every method
 * has an output schema, and a 204 has no body to check against it.
 */
export class ApiStatusResponse<Body> {
  constructor(readonly status: 201 | 202, readonly body: Body) {}
}

/** `return withStatus(201, created)` from a JSON handler. */
export function withStatus<Body>(status: 201 | 202, body: Body): ApiStatusResponse<Body> {
  return new ApiStatusResponse(status, body);
}

type Output<M extends AnyApiMethod> = z.input<M["output"]>;

/**
 * A JSON route: a contract method and the handler that answers it. The
 * router does everything else in one place, in this order: identify the
 * caller, rate limit, room access, input parse, capability, handler, output
 * parse.
 */
export interface ApiJsonRoute<M extends AnyApiMethod = AnyApiMethod> {
  readonly kind: "json";
  readonly method: M;
  // Method syntax keeps routes for different methods assignable to one list.
  handler(input: z.output<M["input"]>, call: ApiCallContext): Promise<Output<M> | ApiStatusResponse<Output<M>>> | Output<M> | ApiStatusResponse<Output<M>>;
}

/**
 * A stream route (`response: "stream"`): the same pipeline, then the handler
 * owns `res` (server-sent events). It resolves when the stream ends.
 */
export interface ApiStreamRoute<M extends AnyApiMethod = AnyApiMethod> {
  readonly kind: "stream";
  readonly method: M;
  handler(input: z.output<M["input"]>, call: ApiCallContext, res: Response): Promise<void>;
}

export type ApiRoute<M extends AnyApiMethod = AnyApiMethod> = ApiJsonRoute<M> | ApiStreamRoute<M>;

/**
 * Binds a handler to a JSON contract method. The handler gets the parsed
 * input (query for a GET or DELETE, JSON body otherwise, plus `:params` from
 * the path) and returns the output, or `withStatus(201, output)`. It throws
 * ApiError for an expected refusal. Fields the output schema does not name
 * are dropped before the answer is sent.
 */
export function defineRoute<M extends AnyApiMethod>(method: M, handler: ApiJsonRoute<M>["handler"]): ApiJsonRoute<M> {
  if (method.response !== "json") throw new TypeError(`${method.name} is a stream method; use defineStreamRoute.`);
  return { kind: "json", method, handler };
}

/** Binds a handler to a stream contract method; it writes to `res` itself. */
export function defineStreamRoute<M extends AnyApiMethod>(method: M, handler: ApiStreamRoute<M>["handler"]): ApiStreamRoute<M> {
  if (method.response !== "stream") throw new TypeError(`${method.name} is a JSON method; use defineRoute.`);
  return { kind: "stream", method, handler };
}

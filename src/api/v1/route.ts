import type { z } from "zod";

import type { AnyApiMethod } from "../../../shared/api/core.mjs";
import type { ApiCallContext } from "./context.js";

/**
 * One /api/v1 route: a contract method and the handler that answers it. The
 * router does everything else in one place, in this order: actor and room
 * access, capability, rate limit, input parse, handler, output check.
 */
export interface ApiRoute<M extends AnyApiMethod = AnyApiMethod> {
  readonly method: M;
  // Method syntax keeps routes for different methods assignable to one list.
  handler(input: z.output<M["input"]>, call: ApiCallContext): Promise<z.input<M["output"]>> | z.input<M["output"]>;
}

/**
 * Binds a handler to a contract method. The handler gets the parsed input
 * (query for a GET or DELETE, JSON body otherwise, plus `:params` from the
 * path) and returns the output; it throws ApiError for an expected refusal.
 */
export function defineRoute<M extends AnyApiMethod>(method: M, handler: ApiRoute<M>["handler"]): ApiRoute<M> {
  return { method, handler };
}

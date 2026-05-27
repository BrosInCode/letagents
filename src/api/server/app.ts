import express from "express";

import {
  registerHttpMiddleware,
  type HttpMiddlewareDeps,
} from "../http-middleware.js";
import { resolveRequestAuth } from "../request-auth.js";
import { registerApiRoutes } from "./routes.js";

export function createApiApp() {
  const app = express();

  const httpMiddlewareDeps = {
    resolveRequestAuth,
  } satisfies HttpMiddlewareDeps;

  registerHttpMiddleware(app, httpMiddlewareDeps);
  registerApiRoutes(app);

  return app;
}

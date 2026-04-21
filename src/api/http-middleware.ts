import express, { type Express } from "express";

import type {
  AuthenticatedRequest,
  ResolvedRequestAuth,
} from "./http-helpers.js";
import { LETAGENTS_ORIGIN_ROOM_ID_HEADER } from "../shared/request-headers.js";

export interface HttpMiddlewareDeps {
  resolveRequestAuth(req: AuthenticatedRequest): Promise<ResolvedRequestAuth>;
}

function buildAllowedOrigins(): Set<string> {
  return new Set([
    "https://letagents.chat",
    "http://localhost:3001",
    "http://localhost:3000",
    "http://127.0.0.1:3001",
    "http://127.0.0.1:3000",
    ...(process.env.LETAGENTS_BASE_URL
      ? [process.env.LETAGENTS_BASE_URL.replace(/\/+$/, "")]
      : []),
    ...(process.env.PUBLIC_API_URL
      ? [process.env.PUBLIC_API_URL.replace(/\/+$/, "")]
      : []),
  ]);
}

export function registerHttpMiddleware(
  app: Express,
  deps: HttpMiddlewareDeps
): void {
  app.use(
    express.json({
      limit: "1mb",
      verify(req, _res, buf) {
        const request = req as AuthenticatedRequest & { originalUrl?: string };
        if (request.originalUrl?.startsWith("/webhooks/github")) {
          request.rawBody = Buffer.from(buf);
        }
      },
    })
  );

  app.use(async (req: AuthenticatedRequest, _res, next) => {
    try {
      const auth = await deps.resolveRequestAuth(req);
      req.sessionAccount = auth.account;
      req.authKind = auth.authKind;
      next();
    } catch (error) {
      next(error);
    }
  });

  const allowedOrigins = buildAllowedOrigins();
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      `Content-Type, Authorization, ${LETAGENTS_ORIGIN_ROOM_ID_HEADER}`
    );
    next();
  });

  app.options("{*path}", (_req, res) => {
    res.sendStatus(204);
  });
}

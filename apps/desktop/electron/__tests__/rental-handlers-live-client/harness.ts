import assert from "node:assert/strict";

import {
  registerDesktopRentalIpcHandlers,
  type DesktopRentalHandlerOptions,
} from "../../rental-handlers.js";
import type { RentalApiClient, RentalApiResult } from "../../rental/api-client.js";

export type CapturedHandler = (_event: any, ...args: any[]) => unknown;

export interface FakeCall {
  method: string;
  args: unknown[];
}

export function captureHandlers(
  enabled: boolean,
  options: DesktopRentalHandlerOptions = {},
): Map<string, CapturedHandler> {
  const handlers = new Map<string, CapturedHandler>();
  registerDesktopRentalIpcHandlers(
    {
      handle(channel: string, handler: CapturedHandler) {
        handlers.set(channel, handler);
      },
    },
    { enabled, ...options },
  );
  return handlers;
}

export function captureHandlersWithClient(
  client: RentalApiClient | null,
  options: DesktopRentalHandlerOptions = {},
): Map<string, CapturedHandler> {
  return captureHandlers(true, { apiClient: client, ...options });
}

export function makeFakeClient(
  scripted: Partial<Record<keyof RentalApiClient, RentalApiResult<unknown>>>,
): { client: RentalApiClient; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fallback: RentalApiResult<unknown> = {
    ok: false,
    status: 0,
    error: "no_script",
    body: null,
  };
  const proxy = new Proxy({} as RentalApiClient, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return async (...args: unknown[]) => {
        calls.push({ method: prop, args });
        return scripted[prop as keyof RentalApiClient] ?? fallback;
      };
    },
  });
  return { client: proxy, calls };
}

export async function invoke(
  handlers: Map<string, CapturedHandler>,
  channel: string,
  ...args: unknown[]
) {
  const handler = handlers.get(channel);
  assert.ok(handler, `expected ${channel} to be registered`);
  return handler(null, ...args);
}

export function waitForFireAndForget(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

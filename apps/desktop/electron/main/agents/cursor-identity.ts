import { createServer, type Server as HttpServer } from "node:http";
import { request as httpsRequest } from "node:https";

import { runCursorSandboxedInspection } from "./cursor-mcp-authority.js";
import type { CursorPersonalIdentity } from "./cursor-managed-profile.js";
import { CURSOR_IDENTITY_ATTESTATION_TIMEOUT_MS } from "./cursor-provider-constants.js";

export class CursorIdentityAuthRequiredError extends Error {
  constructor() {
    super("Cursor Agent needs sign-in before its live identity can be supervised.");
    this.name = "CursorIdentityAuthRequiredError";
  }
}

export class CursorTeamManagedIdentityError extends Error {
  constructor() {
    super(
      "Team-managed Cursor accounts are not supported for supervised agents because Cursor team policy cannot be safely mediated yet.",
    );
    this.name = "CursorTeamManagedIdentityError";
  }
}

export async function assertCursorPersonalIdentity(input: {
  cursorBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  writableProfileRoot: string;
  requiredReadableRoots?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CursorPersonalIdentity> {
  const proxy = await startCursorIdentityProxy(input.signal);
  try {
    const result = await runCursorSandboxedInspection({
      cursorBin: input.cursorBin,
      commandArgs: [
        "--endpoint", proxy.endpoint,
        "--http-version", "1.1",
        "--disable-auto-update",
        "status", "--format", "json",
      ],
      cwd: input.cwd,
      env: input.env,
      writableProfileRoot: input.writableProfileRoot,
      requiredReadableRoots: input.requiredReadableRoots,
      allowedNetworkRemotes: [proxy.remote],
      timeoutMs: input.timeoutMs ?? CURSOR_IDENTITY_ATTESTATION_TIMEOUT_MS,
      signal: input.signal,
    });
    if (!result.ok) {
      const detail = result.stderr.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
        || result.errorCode
        || "native status failed";
      throw new Error(`Cursor live identity attestation failed: ${detail}`);
    }
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const userInfo = parsed.userInfo;
    if (parsed.status === "unauthenticated" || parsed.isAuthenticated === false) {
      throw new CursorIdentityAuthRequiredError();
    }
    if (parsed.status !== "authenticated"
      || parsed.isAuthenticated !== true
      || !userInfo
      || typeof userInfo !== "object"
      || Array.isArray(userInfo)
      || typeof (userInfo as Record<string, unknown>).userId !== "number"
      || !Number.isSafeInteger((userInfo as Record<string, unknown>).userId)
      || ((userInfo as Record<string, unknown>).userId as number) <= 0) {
      throw new Error("Cursor could not prove the live account identity.");
    }
    if (Object.prototype.hasOwnProperty.call(userInfo, "teamId")
      && (userInfo as Record<string, unknown>).teamId !== null
      && (userInfo as Record<string, unknown>).teamId !== undefined) {
      throw new CursorTeamManagedIdentityError();
    }
    proxy.assertGetMeCompleted();
    const providerAuthorization = proxy.providerAuthorization();
    const userId = (userInfo as Record<string, unknown>).userId as number;
    const emailValue = (userInfo as Record<string, unknown>).email;
    return {
      userId,
      email: typeof emailValue === "string" && emailValue.trim()
        ? emailValue.trim()
        : null,
      providerAuthorization,
    };
  } finally {
    await proxy.close();
  }
}

function startCursorIdentityProxy(signal?: AbortSignal): Promise<{
  endpoint: string;
  remote: string;
  assertGetMeCompleted(): void;
  providerAuthorization(): string;
  close(): Promise<void>;
}> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Cursor live identity attestation was interrupted."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let getMeRequests = 0;
    let getMeSuccesses = 0;
    let providerAuthorization: string | null = null;
    const server: HttpServer = createServer((request, response) => {
      const requestPath = typeof request.url === "string" ? request.url : "";
      if (request.method !== "POST"
        || requestPath !== "/aiserver.v1.DashboardService/GetMe") {
        request.resume();
        response.writeHead(503, { connection: "close", "cache-control": "no-store" });
        response.end("Cursor identity attestation permits only GetMe.");
        return;
      }
      getMeRequests += 1;
      const requestAuthorization = request.headers.authorization;
      if (typeof requestAuthorization !== "string"
        || !/^Bearer [^\s\0]{1,16384}$/.test(requestAuthorization)
        || (providerAuthorization !== null && providerAuthorization !== requestAuthorization)) {
        request.resume();
        response.writeHead(503, { connection: "close", "cache-control": "no-store" });
        response.end("Cursor identity authorization was rejected.");
        return;
      }
      providerAuthorization = requestAuthorization;
      const contentLengthHeader = request.headers["content-length"];
      const contentLength = typeof contentLengthHeader === "string" && /^\d{1,7}$/.test(contentLengthHeader)
        ? Number(contentLengthHeader)
        : -1;
      if (request.headers["transfer-encoding"] !== undefined
        || !Number.isSafeInteger(contentLength)
        || contentLength < 0
        || contentLength > 1024 * 1024) {
        request.resume();
        response.writeHead(503, { connection: "close", "cache-control": "no-store" });
        response.end("Cursor identity request framing was rejected.");
        return;
      }
      const headers: Record<string, string | string[] | undefined> = {
        ...request.headers,
        host: "api2.cursor.sh",
      };
      delete headers.connection;
      delete headers["proxy-connection"];
      delete headers.upgrade;
      delete headers["keep-alive"];
      delete headers["transfer-encoding"];
      const upstream = httpsRequest({
        protocol: "https:",
        hostname: "api2.cursor.sh",
        port: 443,
        method: "POST",
        path: requestPath,
        headers,
        servername: "api2.cursor.sh",
        timeout: 15_000,
      }, (upstreamResponse) => {
        const responseHeaders: Record<string, string | string[] | undefined> = {
          ...upstreamResponse.headers,
        };
        delete responseHeaders.connection;
        delete responseHeaders["proxy-connection"];
        delete responseHeaders.upgrade;
        delete responseHeaders["keep-alive"];
        response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
        let responseBytes = 0;
        upstreamResponse.on("data", (chunk: Buffer) => {
          responseBytes += chunk.length;
          if (responseBytes > 1024 * 1024) {
            upstreamResponse.destroy();
            response.destroy();
          }
        });
        upstreamResponse.once("end", () => {
          if (responseBytes <= 1024 * 1024
            && (upstreamResponse.statusCode ?? 0) >= 200
            && (upstreamResponse.statusCode ?? 0) < 300) {
            getMeSuccesses += 1;
          }
        });
        upstreamResponse.once("error", () => response.destroy());
        upstreamResponse.pipe(response);
      });
      upstream.once("timeout", () => upstream.destroy(new Error("Cursor GetMe timed out.")));
      upstream.once("error", () => {
        if (!response.headersSent) response.writeHead(502, { connection: "close" });
        response.end();
      });
      request.once("aborted", () => upstream.destroy());
      let receivedBytes = 0;
      let overflow = false;
      request.on("data", (chunk: Buffer) => {
        if (overflow) return;
        receivedBytes += chunk.length;
        if (receivedBytes > 1024 * 1024) {
          overflow = true;
          upstream.destroy();
          if (!response.headersSent) response.writeHead(413, { connection: "close" });
          response.end();
          request.resume();
          return;
        }
        if (!upstream.write(chunk)) {
          request.pause();
          upstream.once("drain", () => request.resume());
        }
      });
      request.once("end", () => { if (!overflow) upstream.end(); });
      request.once("error", () => upstream.destroy());
    });
    server.maxHeadersCount = 64;
    server.headersTimeout = 5_000;
    server.requestTimeout = 20_000;
    server.keepAliveTimeout = 1_000;
    const abort = (): void => {
      server.close();
      if (!settled) {
        settled = true;
        reject(new Error("Cursor live identity attestation was interrupted."));
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    server.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      if (settled) return;
      const address = server.address();
      if (!address || typeof address === "string") {
        settled = true;
        signal?.removeEventListener("abort", abort);
        server.close();
        reject(new Error("Cursor identity proxy did not expose a loopback port."));
        return;
      }
      settled = true;
      resolve({
        endpoint: `http://127.0.0.1:${address.port}`,
        remote: `localhost:${address.port}`,
        assertGetMeCompleted() {
          if (getMeRequests !== 1 || getMeSuccesses !== 1 || providerAuthorization === null) {
            throw new Error("Cursor did not complete exactly one live GetMe identity proof.");
          }
        },
        providerAuthorization() {
          if (providerAuthorization === null) {
            throw new Error("Cursor did not provide a live authorization proof.");
          }
          return providerAuthorization;
        },
        close: () => new Promise<void>((resolveClose) => {
          signal?.removeEventListener("abort", abort);
          server.closeAllConnections?.();
          server.close(() => resolveClose());
        }),
      });
    });
  });
}

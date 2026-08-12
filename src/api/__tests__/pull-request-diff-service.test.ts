import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import type { GitHubAppConfig } from "../github/config.js";
import {
  fetchPullRequestUnifiedDiff,
  PullRequestDiffError,
} from "../github/pull-request-diff.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const config = { appId: "123", appSlug: "letagents", privateKey, baseUrl: "" } as GitHubAppConfig;

function mockFetch(opts: {
  headShas?: string[];
  diffStatus?: number;
  diffContentType?: string;
  diffBody?: string;
}): typeof fetch {
  const headShas = opts.headShas ?? ["s1", "s1"];
  let jsonCall = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const accept = ((init?.headers as Record<string, string>) ?? {}).Accept ?? "";
    if (u.endsWith("/access_tokens")) {
      return new Response(JSON.stringify({ token: "tok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/pulls/") && accept.includes("json")) {
      const sha = headShas[Math.min(jsonCall, headShas.length - 1)];
      jsonCall += 1;
      return new Response(JSON.stringify({ head: { sha } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/pulls/") && accept.includes("diff")) {
      const status = opts.diffStatus ?? 200;
      if (status !== 200) return new Response("err", { status });
      return new Response(opts.diffBody ?? "diff --git a b", {
        status: 200,
        headers: { "content-type": opts.diffContentType ?? "application/vnd.github.v3.diff" },
      });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

function run(fetchImpl: typeof fetch, maxBytes?: number, timeoutMs?: number) {
  return fetchPullRequestUnifiedDiff({
    owner: "octo",
    repo: "repo",
    number: 42,
    installationId: "inst_1",
    config,
    fetchImpl,
    maxBytes,
    timeoutMs,
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PullRequestDiffError, "PullRequestDiffError");
    assert.equal((error as PullRequestDiffError).code, code);
    return true;
  });
}

test("returns the diff and verified head SHA on the happy path", async () => {
  const result = await run(mockFetch({ headShas: ["s1", "s1"] }));
  assert.deepEqual(result, { diff: "diff --git a b", headSha: "s1" });
});

test("fails as 'moved' when the head SHA changes during the fetch", async () => {
  await expectCode(run(mockFetch({ headShas: ["s1", "s2"] })), "moved");
});

test("rejects an unexpected content type", async () => {
  await expectCode(run(mockFetch({ diffContentType: "application/json" })), "invalid_content");
});

test("rejects an oversized diff (byte cap)", async () => {
  await expectCode(run(mockFetch({ diffBody: "x".repeat(4096) }), 64), "too_large");
});

test("maps GitHub statuses to typed error codes", async () => {
  await expectCode(run(mockFetch({ diffStatus: 404 })), "not_found");
  await expectCode(run(mockFetch({ diffStatus: 403 })), "forbidden");
  await expectCode(run(mockFetch({ diffStatus: 429 })), "rate_limited");
});

function headOrToken(url: string, accept: string): Response | null {
  if (url.endsWith("/access_tokens")) {
    return new Response(JSON.stringify({ token: "tok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes("/pulls/") && accept.includes("json")) {
    return new Response(JSON.stringify({ head: { sha: "s1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

test("times out when the response body stalls after headers (post-header read)", async () => {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const accept = ((init?.headers as Record<string, string>) ?? {}).Accept ?? "";
    const early = headOrToken(u, accept);
    if (early) return early;
    // Diff response: headers arrive immediately, but the body stalls mid-read until
    // the operation's deadline aborts the request signal.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial diff "));
      },
      pull(controller) {
        return new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new DOMException("aborted", "AbortError");
            try {
              controller.error(err);
            } catch {
              /* already errored */
            }
            reject(err);
          });
        });
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "application/vnd.github.v3.diff" },
    });
  }) as typeof fetch;
  await expectCode(run(fetchImpl, undefined, 50), "timeout");
});

test("cancels the reader and fails 'too_large' on chunked overflow", async () => {
  let cancelled = false;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const accept = ((init?.headers as Record<string, string>) ?? {}).Accept ?? "";
    const early = headOrToken(u, accept);
    if (early) return early;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(100)); // first chunk already exceeds the cap
        controller.enqueue(new Uint8Array(100));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "application/vnd.github.v3.diff" },
    });
  }) as typeof fetch;
  await expectCode(run(fetchImpl, 50), "too_large");
  assert.equal(cancelled, true, "reader.cancel() invoked on overflow");
});

test("times out when GitHub stalls past the overall deadline", async () => {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const accept = ((init?.headers as Record<string, string>) ?? {}).Accept ?? "";
    if (u.endsWith("/access_tokens")) {
      return new Response(JSON.stringify({ token: "tok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/pulls/") && accept.includes("diff")) {
      // Stall until the operation's deadline aborts the request.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }
    return new Response(JSON.stringify({ head: { sha: "s1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  await expectCode(run(fetchImpl, undefined, 50), "timeout");
});

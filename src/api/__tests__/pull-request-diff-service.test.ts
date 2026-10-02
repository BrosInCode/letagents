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

function filesFetch(mode: "ok" | "failed" | "rate_limited" | "stalled" | "oversized" | "moved") {
  const calls: string[] = [];
  let heads = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    calls.push(path);
    if (path.endsWith("/access_tokens")) return Response.json({ token: "tok" });
    if (path.includes("/files?")) {
      if (mode === "failed" || mode === "rate_limited") return new Response("", { status: mode === "failed" ? 500 : 429 });
      if (mode === "stalled") return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
      if (mode === "oversized") return new Response("[]", { headers: { "content-length": String(6 * 1024 * 1024) } });
      return Response.json([{ filename: "new.ts", previous_filename: "old.ts", status: "renamed", additions: 2, deletions: 1, patch: "ignored", raw_url: "http://127.0.0.1/" }]);
    }
    if ((init?.headers as Record<string, string>).Accept.includes("diff")) {
      // In the successful enhancement fixture the files response finishes first.
      await new Promise<void>(resolve => setImmediate(resolve));
      return new Response("diff --git a/old.ts b/new.ts", { headers: { "content-type": "text/x-diff" } });
    }
    heads++;
    return Response.json({ head: { sha: mode === "moved" && heads === 2 ? "s2" : "s1" }, changed_files: 102 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("metadata opt-in makes exactly one extra bounded first-page request; default fetch makes none", async () => {
  const { fetchImpl, calls } = filesFetch("ok");
  const result = await fetchPullRequestUnifiedDiff({ owner: "octo", repo: "repo", number: 42, installationId: "inst_1", config, fetchImpl, includeFiles: true });
  assert.deepEqual(result.fileList, { files: [{ path: "new.ts", previous_path: "old.ts", status: "renamed", additions: 2, deletions: 1 }], total_files: 102 });
  assert.deepEqual(calls.filter(url => url.includes("/files")), ["https://api.github.com/repos/octo/repo/pulls/42/files?per_page=100&page=1"]);
  const defaultFetch = filesFetch("ok");
  const plain = await run(defaultFetch.fetchImpl);
  assert.deepEqual(Object.keys(plain).sort(), ["diff", "headSha"]);
  assert.equal(defaultFetch.calls.some(url => url.includes("/files")), false);
});

for (const mode of ["failed", "rate_limited", "stalled", "oversized"] as const) {
  test(`a ${mode} files request never discards a successful diff`, async () => {
    const { fetchImpl, calls } = filesFetch(mode);
    const result = await fetchPullRequestUnifiedDiff({
      owner: "octo", repo: "repo", number: 42, installationId: "inst_1", config, fetchImpl, includeFiles: true, timeoutMs: 300,
    });
    assert.equal(result.diff, "diff --git a/old.ts b/new.ts");
    assert.equal(result.fileList, null);
    assert.equal(calls.filter(url => url.includes("/files")).length, 1);
  });
}

test("a changed head also rejects enhanced metadata", async () => {
  await expectCode(fetchPullRequestUnifiedDiff({
    owner: "octo", repo: "repo", number: 42, installationId: "inst_1", config, fetchImpl: filesFetch("moved").fetchImpl, includeFiles: true,
  }), "moved");
});

test("GitHub rate-limit 403 is distinguished from withdrawn permission", async () => {
  const fallback = mockFetch({});
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if ((init?.headers as Record<string, string>).Accept.includes("diff")) {
      return new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    }
    return fallback(url, init);
  }) as typeof fetch;
  await expectCode(run(fetchImpl), "rate_limited");
});

test("optional file metadata cannot delay the final head verification", async () => {
  const fallback = filesFetch("ok").fetchImpl;
  let heads = 0;
  let finishFiles: ((value: Response) => void) | undefined;
  let filesSettled = false;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (String(url).includes("/files?")) {
      return new Promise<Response>((resolve, reject) => {
        finishFiles = resolve;
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }).finally(() => { filesSettled = true; });
    }
    if (String(url).includes("/pulls/") && (init?.headers as Record<string, string>).Accept.includes("json")) {
      heads++;
      // A slow enhancement has not completed when the diff is ready.
      if (heads === 2) {
        assert.equal(filesSettled, false, "required validation must not wait for optional metadata");
        finishFiles?.(new Response("", { status: 503 }));
      }
    }
    return fallback(url, init);
  }) as typeof fetch;
  const result = await fetchPullRequestUnifiedDiff({
    owner: "octo", repo: "repo", number: 42, installationId: "inst_1", config, fetchImpl, includeFiles: true, timeoutMs: 200,
  });
  assert.equal(result.headSha, "s1");
  assert.equal(result.fileList, null);
});

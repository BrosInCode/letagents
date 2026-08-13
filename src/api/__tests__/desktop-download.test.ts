import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import express from "express";

import {
  createDesktopReleaseManifestLoader,
  registerDesktopDownloadRoutes,
  verifyMacDesktopReleaseArtifacts,
} from "../releases/desktop-download.js";
import {
  advanceDesktopReleaseHighWater,
  assertDesktopReleaseAtOrAboveHighWater,
  canUseBundledDesktopReleaseFallback,
} from "../releases/desktop-release-high-water.js";

const currentRelease = {
  schemaVersion: 1 as const,
  channel: "beta" as const,
  version: "0.1.5",
  checksumsUrl: "https://downloads.letagents.chat/desktop/v0.1.5/checksums.txt",
  assets: {
    arm64: {
      fileName: "LetAgents-0.1.5-darwin-arm64.dmg",
      publicUrl: "https://downloads.letagents.chat/desktop/v0.1.5/LetAgents-0.1.5-darwin-arm64.dmg",
      bytes: 120,
      sha256: "a".repeat(64),
    },
    x64: {
      fileName: "LetAgents-0.1.5-darwin-x64.dmg",
      publicUrl: "https://downloads.letagents.chat/desktop/v0.1.5/LetAgents-0.1.5-darwin-x64.dmg",
      bytes: 140,
      sha256: "b".repeat(64),
    },
  },
};

test("durable desktop release high-water accepts forward versions and rejects rollback", async () => {
  let recordedParameters: unknown[] = [];
  await advanceDesktopReleaseHighWater("0.1.7", {
    query: async (_sql: string, parameters?: unknown[]) => {
      recordedParameters = parameters ?? [];
      return { rows: [{ accepted: true, major: 0, minor: 1, patch: 7 }], rowCount: 1 };
    },
  } as never);
  assert.deepEqual(recordedParameters, [0, 1, 7]);

  await assert.rejects(
    advanceDesktopReleaseHighWater("0.1.6", {
      query: async () => ({
        rows: [{ accepted: false, major: 0, minor: 1, patch: 7 }],
        rowCount: 1,
      }),
    } as never),
    /0\.1\.6 is older than durable high-water 0\.1\.7/,
  );
});

test("bundled desktop fallback consults the durable release high-water", async () => {
  assert.equal(await canUseBundledDesktopReleaseFallback("0.1.5", {
    query: async () => ({ rows: [{ allowed: true }], rowCount: 1 }),
  } as never), true);
  assert.equal(await canUseBundledDesktopReleaseFallback("0.1.5", {
    query: async () => ({ rows: [{ allowed: false }], rowCount: 1 }),
  } as never), false);
  await assert.rejects(assertDesktopReleaseAtOrAboveHighWater("0.1.5", {
    query: async () => ({ rows: [{ allowed: false }], rowCount: 1 }),
  } as never), /older than durable high-water/);
});

test("Mac beta routes redirect supported architectures directly to public R2 assets", async (t) => {
  const app = express();
  registerDesktopDownloadRoutes(app, { loadCurrentRelease: async () => currentRelease });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const arm64 = await fetch(`${baseUrl}/downloads/mac/arm64`, { redirect: "manual" });
  assert.equal(arm64.status, 302);
  assert.equal(
    arm64.headers.get("location"),
    "https://downloads.letagents.chat/desktop/v0.1.5/LetAgents-0.1.5-darwin-arm64.dmg",
  );
  assert.equal(arm64.headers.get("cache-control"), "public, max-age=60, must-revalidate");

  const x64 = await fetch(`${baseUrl}/downloads/mac/x64`, { redirect: "manual" });
  assert.equal(x64.status, 302);
  assert.equal(
    x64.headers.get("location"),
    "https://downloads.letagents.chat/desktop/v0.1.5/LetAgents-0.1.5-darwin-x64.dmg",
  );

  const unsupported = await fetch(`${baseUrl}/downloads/mac/universal`, { redirect: "manual" });
  assert.equal(unsupported.status, 404);
});

test("current Mac beta manifest comes from the verified release source", async (t) => {
  const app = express();
  registerDesktopDownloadRoutes(app, {
    loadCurrentRelease: async () => currentRelease,
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const current = await fetch(`${baseUrl}/downloads/mac/current.json`);
  assert.equal(current.status, 200);
  assert.equal(current.headers.get("cache-control"), "public, max-age=30, must-revalidate");
  assert.deepEqual(await current.json(), currentRelease);

});

test("Mac beta downloads retain the bundled release when the current manifest is unavailable", async (t) => {
  const app = express();
  registerDesktopDownloadRoutes(app, {
    loadCurrentRelease: async () => { throw new Error("R2 unavailable"); },
    canUseBundledFallback: async () => true,
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const manifest = await fetch(`${baseUrl}/downloads/mac/current.json`);
  assert.equal(manifest.status, 503);
  assert.equal(manifest.headers.get("cache-control"), "no-store");

  const download = await fetch(`${baseUrl}/downloads/mac/arm64`, { redirect: "manual" });
  assert.equal(download.status, 302);
  assert.match(download.headers.get("location") ?? "", /v0\.1\.5/);
});

test("current release loading caches, expires, and coalesces public requests", async () => {
  let now = 1_000;
  let requests = 0;
  const loader = createDesktopReleaseManifestLoader({
    now: () => now,
    fetcher: async () => {
      requests += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify(currentRelease), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const [first, concurrent] = await Promise.all([
    loader("https://downloads.letagents.chat/desktop/current.json", 45_000),
    loader("https://downloads.letagents.chat/desktop/current.json", 45_000),
  ]);
  assert.equal(requests, 1);
  assert.deepEqual(first, concurrent);

  await loader("https://downloads.letagents.chat/desktop/current.json", 45_000);
  assert.equal(requests, 1);
  now += 45_001;
  await loader("https://downloads.letagents.chat/desktop/current.json", 45_000);
  assert.equal(requests, 2);
});

test("current release loading rejects untrusted asset URLs and briefly throttles failures", async () => {
  let now = 1_000;
  let requests = 0;
  const loader = createDesktopReleaseManifestLoader({
    now: () => now,
    fetcher: async () => {
      requests += 1;
      const body = requests === 1
        ? {
            ...currentRelease,
            assets: {
              ...currentRelease.assets,
              arm64: { ...currentRelease.assets.arm64, publicUrl: "https://attacker.example/LetAgents.dmg" },
            },
          }
        : currentRelease;
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });

  await assert.rejects(
    loader("https://downloads.letagents.chat/desktop/current.json", 45_000),
    /immutable public URL/,
  );
  await assert.rejects(
    loader("https://downloads.letagents.chat/desktop/current.json", 45_000),
    /immutable public URL/,
  );
  assert.equal(requests, 1);
  now += 10_001;
  assert.deepEqual(
    await loader("https://downloads.letagents.chat/desktop/current.json", 45_000),
    currentRelease,
  );
  assert.equal(requests, 2);
});

test("current release loading rejects a valid older release instead of rolling downloads back", async () => {
  const olderRelease = JSON.parse(
    JSON.stringify(currentRelease).replaceAll("0.1.5", "0.1.4"),
  );
  const loader = createDesktopReleaseManifestLoader({
    fetcher: async () => new Response(JSON.stringify(olderRelease), { status: 200 }),
  });

  await assert.rejects(
    loader("https://downloads.letagents.chat/desktop/current.json", 45_000),
    /0\.1\.4 is older than 0\.1\.5/,
  );
});

test("current release loading preserves a durable high-water across cache expiry", async () => {
  let now = 1_000;
  let highWater = "0.1.5";
  const releases = ["0.1.7", "0.1.6"];
  const loader = createDesktopReleaseManifestLoader({
    now: () => now,
    acceptVersion: async (version) => {
      if (version < highWater) throw new Error(`${version} is older than durable high-water ${highWater}`);
      highWater = version;
    },
    fetcher: async () => {
      const version = releases.shift()!;
      const body = JSON.stringify(currentRelease).replaceAll("0.1.5", version);
      return new Response(body, { status: 200 });
    },
  });

  assert.equal((await loader("https://downloads.letagents.chat/desktop/current.json", 45_000)).version, "0.1.7");
  now += 45_001;
  await assert.rejects(
    loader("https://downloads.letagents.chat/desktop/current.json", 45_000),
    /0\.1\.6 is older than durable high-water 0\.1\.7/,
  );
});

test("cached current releases are checked against durable high-water on every response", async () => {
  let highWater = "0.1.5";
  let requests = 0;
  const loader = createDesktopReleaseManifestLoader({
    checkVersion: async (version) => {
      if (version < highWater) throw new Error(`${version} is older than durable high-water ${highWater}`);
    },
    fetcher: async () => {
      requests += 1;
      const body = JSON.stringify(currentRelease).replaceAll("0.1.5", "0.1.7");
      return new Response(body, { status: 200 });
    },
  });

  await loader("https://downloads.letagents.chat/desktop/current.json", 45_000);
  highWater = "0.1.8";
  await assert.rejects(
    loader("https://downloads.letagents.chat/desktop/current.json", 45_000),
    /0\.1\.7 is older than durable high-water 0\.1\.8/,
  );
  assert.equal(requests, 1);
});

test("current release loading rejects oversized declared and chunked bodies", async () => {
  for (const response of [
    new Response("{}", { status: 200, headers: { "Content-Length": String(65 * 1024) } }),
    new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(40 * 1024));
        controller.enqueue(new Uint8Array(40 * 1024));
        controller.close();
      },
    }), { status: 200 }),
  ]) {
    const loader = createDesktopReleaseManifestLoader({ fetcher: async () => response });
    await assert.rejects(
      loader("https://downloads.letagents.chat/desktop/current.json", 45_000),
      /exceeds the 65536-byte limit/,
    );
  }
});

test("future manifests prove immutable installer size and publisher checksum before high-water advances", async () => {
  const futureRelease = JSON.parse(
    JSON.stringify(currentRelease).replaceAll("0.1.5", "0.1.8"),
  );
  let accepted = false;
  let artifactRequests = 0;
  const artifactFetcher: typeof fetch = async (input, init) => {
    artifactRequests += 1;
    const url = String(input);
    const architecture = url.includes("arm64") ? "arm64" : "x64";
    const asset = futureRelease.assets[architecture];
    if (init?.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Length": String(asset.bytes),
          "Cache-Control": "public,max-age=31536000,immutable",
        },
      });
    }
    return new Response(`${asset.sha256}  ${asset.fileName}\n`, {
      status: 200,
      headers: { "Cache-Control": "public,max-age=31536000,immutable" },
    });
  };
  const loader = createDesktopReleaseManifestLoader({
    fetcher: async () => new Response(JSON.stringify(futureRelease), { status: 200 }),
    verifyRelease: (release) => verifyMacDesktopReleaseArtifacts(release, artifactFetcher),
    acceptVersion: async () => { accepted = true; },
  });

  assert.equal((await loader("https://downloads.letagents.chat/desktop/current.json", 45_000)).version, "0.1.8");
  assert.equal(artifactRequests, 4);
  assert.equal(accepted, true);
});

test("an unproven future manifest cannot poison durable high-water", async () => {
  const poisonedRelease = JSON.parse(
    JSON.stringify(currentRelease).replaceAll("0.1.5", "2147483647.2147483647.2147483647"),
  );
  let accepted = false;
  const loader = createDesktopReleaseManifestLoader({
    fetcher: async () => new Response(JSON.stringify(poisonedRelease), { status: 200 }),
    verifyRelease: async (release) => verifyMacDesktopReleaseArtifacts(
      release,
      async () => new Response("Not found", { status: 404 }),
    ),
    acceptVersion: async () => { accepted = true; },
  });

  await assert.rejects(
    loader("https://downloads.letagents.chat/desktop/current.json", 45_000),
    /asset returned HTTP 404/,
  );
  assert.equal(accepted, false);
});

test("artifact proof rejects mismatched sizes, mutable objects, and checksum sidecars", async () => {
  const asset = currentRelease.assets.arm64;
  for (const fetcher of [
    async (_input: URL | RequestInfo, init?: RequestInit) => init?.method === "HEAD"
      ? new Response(null, { status: 200, headers: { "Content-Length": "1", "Cache-Control": "immutable" } })
      : new Response(`${asset.sha256}  ${asset.fileName}\n`, { status: 200, headers: { "Cache-Control": "immutable" } }),
    async (_input: URL | RequestInfo, init?: RequestInit) => init?.method === "HEAD"
      ? new Response(null, { status: 200, headers: { "Content-Length": String(asset.bytes) } })
      : new Response(`${asset.sha256}  ${asset.fileName}\n`, { status: 200, headers: { "Cache-Control": "immutable" } }),
    async (_input: URL | RequestInfo, init?: RequestInit) => init?.method === "HEAD"
      ? new Response(null, { status: 200, headers: { "Content-Length": String(asset.bytes), "Cache-Control": "immutable" } })
      : new Response(`wrong  ${asset.fileName}\n`, { status: 200, headers: { "Cache-Control": "immutable" } }),
  ] as typeof fetch[]) {
    await assert.rejects(verifyMacDesktopReleaseArtifacts(currentRelease, fetcher));
  }
});

test("Mac beta downloads fail closed when the bundled fallback is below durable high-water", async (t) => {
  const app = express();
  registerDesktopDownloadRoutes(app, {
    loadCurrentRelease: async () => { throw new Error("R2 unavailable"); },
    canUseBundledFallback: async () => false,
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/downloads/mac/arm64`, { redirect: "manual" });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("Mac beta checksum route is public and names both signed DMGs", async (t) => {
  const app = express();
  registerDesktopDownloadRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/downloads/mac/v0.1.5/checksums`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /immutable/);
  const body = await response.text();
  assert.match(body, /LetAgents for Mac beta v0\.1\.5/);
  assert.match(body, /LetAgents-0\.1\.5-darwin-arm64\.dmg/);
  assert.match(body, /LetAgents-0\.1\.5-darwin-x64\.dmg/);
  assert.match(body, /704355796cee5214a9cfbb79105a035e0e00dc3a3aa57be7d389b97cf35fc804/);
  assert.match(body, /1e4b0b8b2c42ad8eaaf652fc887ab089445c8dd83233d763a6acdaa6617c2471/);
});

test("previous immutable Mac beta checksum routes remain available", async (t) => {
  const app = express();
  registerDesktopDownloadRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  for (const version of ["0.1.4", "0.1.3", "0.1.2"]) {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/downloads/mac/v${version}/checksums`,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /immutable/);
    const body = await response.text();
    assert.match(body, new RegExp(`LetAgents for Mac beta v${version.replaceAll(".", "\\.")}`));
    assert.match(body, new RegExp(`LetAgents-${version.replaceAll(".", "\\.")}-darwin-arm64\\.dmg`));
    assert.match(body, new RegExp(`LetAgents-${version.replaceAll(".", "\\.")}-darwin-x64\\.dmg`));
  }
});

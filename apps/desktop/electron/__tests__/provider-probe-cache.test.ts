import "./isolated-home.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  cachedProbe,
  clearProbeCache,
  PROVIDER_PROBE_TTL_MS,
  probeKey,
} from "../main/agents/provider-probe-cache.js";

test.beforeEach(() => clearProbeCache());
test.after(() => clearProbeCache());

test("probe keys separate the command, the arguments and the working directory", () => {
  assert.equal(probeKey("codex", ["--version"]), probeKey("codex", ["--version"], null));
  assert.notEqual(probeKey("codex", ["--version"]), probeKey("claude", ["--version"]));
  assert.notEqual(probeKey("codex", ["login", "status"]), probeKey("codex", ["login", "status", "--json"]));
  assert.notEqual(probeKey("cursor-agent", ["--help"], "/repo/a"), probeKey("cursor-agent", ["--help"], "/repo/b"));
  assert.notEqual(probeKey("cursor-agent", ["--help"]), probeKey("cursor-agent", ["--help"], "/repo/a"));
  assert.notEqual(
    probeKey("tool", ["a b"]),
    probeKey("tool", ["a", "b"]),
    "joined arguments must not collide with split arguments",
  );
});

test("a repeated key inside the window runs the probe once", async () => {
  let runs = 0;
  const run = async () => {
    runs += 1;
    return `output ${runs}`;
  };
  const key = probeKey("codex", ["--version"]);

  assert.equal(await cachedProbe(key, run, 1_000), "output 1");
  assert.equal(await cachedProbe(key, run, 1_000 + PROVIDER_PROBE_TTL_MS - 1), "output 1");
  assert.equal(runs, 1);

  assert.equal(await cachedProbe(probeKey("codex", ["login", "status"]), run, 1_000), "output 2");
  assert.equal(runs, 2, "a different key is a different probe");
});

test("concurrent callers share one in-flight promise", async () => {
  let runs = 0;
  let release!: (value: string) => void;
  const run = () => {
    runs += 1;
    return new Promise<string>((resolve) => { release = resolve; });
  };
  const key = probeKey("claude", ["auth", "status"]);

  const first = cachedProbe(key, run, 5_000);
  const second = cachedProbe(key, run, 5_000);
  assert.equal(second, first, "the second caller receives the same promise");
  assert.equal(runs, 1);

  release("signed in");
  assert.deepEqual(await Promise.all([first, second]), ["signed in", "signed in"]);
  assert.equal(runs, 1);
});

test("the probe runs again once the window has passed", async () => {
  let runs = 0;
  const run = async () => {
    runs += 1;
    return runs;
  };
  const key = probeKey("opencode", ["--version"]);

  assert.equal(await cachedProbe(key, run, 10_000), 1);
  assert.equal(await cachedProbe(key, run, 10_000 + PROVIDER_PROBE_TTL_MS - 1), 1);
  assert.equal(await cachedProbe(key, run, 10_000 + PROVIDER_PROBE_TTL_MS), 2, "the entry expires at the end of the window");
  assert.equal(await cachedProbe(key, run, 10_000 + PROVIDER_PROBE_TTL_MS + 1), 2, "the new result starts a new window");
  assert.equal(runs, 2);
});

test("a rejected probe is not cached", async () => {
  let runs = 0;
  const run = async () => {
    runs += 1;
    if (runs === 1) throw new Error("probe crashed");
    return "recovered";
  };
  const key = probeKey("codex", ["--version"]);

  await assert.rejects(cachedProbe(key, run, 1_000), /probe crashed/);
  // The eviction runs in a promise reaction; let it settle before the retry.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await cachedProbe(key, run, 1_001), "recovered");
  assert.equal(runs, 2);
  assert.equal(await cachedProbe(key, run, 1_002), "recovered", "the successful retry is cached");
  assert.equal(runs, 2);
});

test("clearing the cache forgets every probe", async () => {
  let runs = 0;
  const run = async () => {
    runs += 1;
    return runs;
  };
  const version = probeKey("codex", ["--version"]);
  const auth = probeKey("codex", ["login", "status"]);

  assert.equal(await cachedProbe(version, run, 1_000), 1);
  assert.equal(await cachedProbe(auth, run, 1_000), 2);
  assert.equal(await cachedProbe(version, run, 1_001), 1);
  assert.equal(await cachedProbe(auth, run, 1_001), 2);

  clearProbeCache();

  assert.equal(await cachedProbe(version, run, 1_002), 3);
  assert.equal(await cachedProbe(auth, run, 1_002), 4);
  assert.equal(runs, 4);
});

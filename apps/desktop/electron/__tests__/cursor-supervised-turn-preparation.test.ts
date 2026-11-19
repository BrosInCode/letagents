import "./isolated-home.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import test from "node:test";

import { removeDisposableCursorProfileRoot } from "../main/agents/cursor/profile-filesystem.js";
import { prepareSupervisedTurn } from "../main/agents/cursor/supervised-turn-preparation.js";
import type { CursorProviderHandle } from "../main/agents/cursor/lane-state.js";
import { removeCursorTurnRuntimeDataDir } from "../main/agents/cursor-sandbox-policy.js";
import {
  createHarness,
  spawnDaemonLane,
  supervisedAdapter,
} from "./cursor-provider-adapter.fixture.js";

function fsError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

test("removeDisposableCursorProfileRoot retries transient Windows EPERM/ENOTEMPTY/EBUSY errors and succeeds once cleared", async () => {
  const codes = ["EPERM", "ENOTEMPTY", "EBUSY"];
  const delays: number[] = [];
  let nowMs = 1_000;
  let attempts = 0;

  await removeDisposableCursorProfileRoot("C:\\Temp\\letagents-cursor-mcp-bridge-test", {
    platform: "win32",
    timeoutMs: 1_000,
    initialDelayMs: 25,
    maxDelayMs: 100,
    now: () => nowMs,
    wait: async (ms) => {
      delays.push(ms);
      nowMs += ms;
    },
    rmImpl: async () => {
      attempts += 1;
      const code = codes[attempts - 1];
      if (code) throw fsError(code, `${code}: transient NTFS delete-pending`);
    },
  });

  assert.equal(attempts, 4);
  assert.deepEqual(delays, [25, 50, 100]);
});

test("removeDisposableCursorProfileRoot fails closed after Windows retry budget and does not retry non-transient errors or POSIX", async () => {
  let nowMs = 0;
  let winAttempts = 0;
  await assert.rejects(
    removeDisposableCursorProfileRoot("C:\\Temp\\letagents-cursor-mcp-inspection-stuck", {
      platform: "win32",
      timeoutMs: 80,
      initialDelayMs: 25,
      maxDelayMs: 50,
      now: () => nowMs,
      wait: async (ms) => { nowMs += ms; },
      rmImpl: async () => {
        winAttempts += 1;
        throw fsError("EPERM", "EPERM: permanently held");
      },
    }),
    /permanently held/,
  );
  assert.ok(winAttempts >= 3);

  let nonTransientAttempts = 0;
  await assert.rejects(
    removeDisposableCursorProfileRoot("C:\\Temp\\letagents-cursor-mcp-inspection-eacces", {
      platform: "win32",
      rmImpl: async () => {
        nonTransientAttempts += 1;
        throw fsError("EACCES", "EACCES: denied");
      },
    }),
    /EACCES/,
  );
  assert.equal(nonTransientAttempts, 1);

  let posixAttempts = 0;
  await assert.rejects(
    removeDisposableCursorProfileRoot("/tmp/letagents-cursor-mcp-inspection-posix", {
      platform: "darwin",
      rmImpl: async () => {
        posixAttempts += 1;
        throw fsError("EPERM", "EPERM: darwin");
      },
    }),
    /darwin/,
  );
  assert.equal(posixAttempts, 1);
});

test("prepareSupervisedTurn retries transient Windows inspection-root removal and starts pass two only after pass one is removed", async () => {
  const harness = createHarness();
  const seenRoots: string[] = [];
  let inspectionRoot: string | null = null;
  let bridgeSawInspectionRootAlive: boolean | null = null;
  let inspectionRmAttempts = 0;

  harness.dependencies.attestSupervisedMcp = async (input) => {
    seenRoots.push(input.writableProfileRoot);
    if (seenRoots.length === 1) {
      inspectionRoot = input.writableProfileRoot;
    } else if (seenRoots.length === 2 && inspectionRoot) {
      bridgeSawInspectionRootAlive = existsSync(inspectionRoot);
    }
  };
  harness.dependencies.removeDisposableProfileRoot = (targetPath) =>
    removeDisposableCursorProfileRoot(targetPath, {
      platform: "win32",
      initialDelayMs: 1,
      maxDelayMs: 5,
      timeoutMs: 200,
      wait: async () => {},
      rmImpl: async (path, options) => {
        if (path === inspectionRoot) {
          inspectionRmAttempts += 1;
          if (inspectionRmAttempts === 1) throw fsError("EPERM", "EPERM: transient root lock");
          if (inspectionRmAttempts === 2) throw fsError("ENOTEMPTY", "ENOTEMPTY: transient delete-pending");
        }
        await rm(path, options);
      },
    });

  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness) as CursorProviderHandle;
  const prepared = await prepareSupervisedTurn(
    adapter,
    handle,
    "room_turn_1",
    undefined,
    [],
    false,
    "https://letagents.chat",
  );
  try {
    assert.equal(seenRoots.length, 2);
    assert.equal(inspectionRmAttempts, 3);
    assert.equal(bridgeSawInspectionRootAlive, false, "pass two must start only after pass one's root is deleted");
    assert.ok(inspectionRoot && !existsSync(inspectionRoot));
    assert.equal(existsSync(seenRoots[1]!), false);
  } finally {
    if (prepared.supervisedRuntimeDataDir) removeCursorTurnRuntimeDataDir(prepared.supervisedRuntimeDataDir);
  }
});

test("prepareSupervisedTurn fails closed and never starts pass two when pass-one root removal fails persistently", async () => {
  const harness = createHarness();
  const seenRoots: string[] = [];
  let leakedInspectionRoot: string | null = null;

  harness.dependencies.attestSupervisedMcp = async (input) => {
    seenRoots.push(input.writableProfileRoot);
    if (seenRoots.length === 1) leakedInspectionRoot = input.writableProfileRoot;
  };
  harness.dependencies.removeDisposableProfileRoot = async (targetPath) => {
    if (targetPath === leakedInspectionRoot) {
      throw fsError("EPERM", "EPERM: persistent handle");
    }
    await rm(targetPath, { recursive: true, force: true });
  };

  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness) as CursorProviderHandle;
  try {
    await assert.rejects(
      prepareSupervisedTurn(
        adapter,
        handle,
        "room_turn_fail_closed",
        undefined,
        [],
        false,
        "https://letagents.chat",
      ),
      /persistent handle/,
    );
    assert.equal(seenRoots.length, 1, "pass two must never start when pass one's root could not be removed");
  } finally {
    if (leakedInspectionRoot && existsSync(leakedInspectionRoot)) {
      await rm(leakedInspectionRoot, { recursive: true, force: true });
    }
  }
});

test("prepareSupervisedTurn preserves the original pass-one failure when cleanup also fails", async () => {
  const harness = createHarness();
  let failedInspectionRoot: string | null = null;
  let cleanupAttempted = false;

  harness.dependencies.attestSupervisedMcp = async (input) => {
    failedInspectionRoot = input.writableProfileRoot;
    throw new Error("Cursor failed while inspecting the effective supervised MCP registry (ETIMEDOUT).");
  };
  harness.dependencies.removeDisposableProfileRoot = async (targetPath) => {
    cleanupAttempted = true;
    if (targetPath === failedInspectionRoot) {
      throw fsError("EPERM", "EPERM: should not mask ETIMEDOUT");
    }
    await rm(targetPath, { recursive: true, force: true });
  };

  const adapter = supervisedAdapter(harness);
  const handle = await spawnDaemonLane(adapter, harness) as CursorProviderHandle;
  try {
    await assert.rejects(
      prepareSupervisedTurn(
        adapter,
        handle,
        "room_turn_preserve_error",
        undefined,
        [],
        false,
        "https://letagents.chat",
      ),
      /ETIMEDOUT/,
    );
    assert.equal(cleanupAttempted, true);
  } finally {
    if (failedInspectionRoot && existsSync(failedInspectionRoot)) {
      await rm(failedInspectionRoot, { recursive: true, force: true });
    }
  }
});

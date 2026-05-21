import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { findLetagentsConfig, getRoomFromConfig } from "../config-reader.js";

// Helper to create temp directories with config files
function createTempDir(): string {
  const dir = join(tmpdir(), `letagents-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

// ── findLetagentsConfig ─────────────────────────────────

test("findLetagentsConfig returns config when .letagents.json is in the start directory", () => {
  const tempDir = createTempDir();
  try {
    writeFileSync(
      join(tempDir, ".letagents.json"),
      JSON.stringify({ room: "github.com/BrosInCode/letagents" })
    );

    const config = findLetagentsConfig(tempDir);
    assert.deepEqual(config, { room: "github.com/BrosInCode/letagents" });
  } finally {
    cleanup(tempDir);
  }
});

test("findLetagentsConfig walks up to find config in parent directory", () => {
  const tempDir = createTempDir();
  try {
    const childDir = join(tempDir, "src", "mcp");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      join(tempDir, ".letagents.json"),
      JSON.stringify({ room: "gitlab.com/team/project" })
    );

    const config = findLetagentsConfig(childDir);
    assert.deepEqual(config, { room: "gitlab.com/team/project" });
  } finally {
    cleanup(tempDir);
  }
});

test("findLetagentsConfig returns null when no config file exists", () => {
  const tempDir = createTempDir();
  try {
    const config = findLetagentsConfig(tempDir);
    assert.equal(config, null);
  } finally {
    cleanup(tempDir);
  }
});

test("findLetagentsConfig returns null for config with missing room field", () => {
  const tempDir = createTempDir();
  try {
    writeFileSync(
      join(tempDir, ".letagents.json"),
      JSON.stringify({ version: "1.0" })
    );

    // Suppress console.error for this test
    const originalError = console.error;
    console.error = () => {};
    try {
      const config = findLetagentsConfig(tempDir);
      assert.equal(config, null);
    } finally {
      console.error = originalError;
    }
  } finally {
    cleanup(tempDir);
  }
});

test("findLetagentsConfig returns null for config with empty room field", () => {
  const tempDir = createTempDir();
  try {
    writeFileSync(
      join(tempDir, ".letagents.json"),
      JSON.stringify({ room: "" })
    );

    const originalError = console.error;
    console.error = () => {};
    try {
      const config = findLetagentsConfig(tempDir);
      assert.equal(config, null);
    } finally {
      console.error = originalError;
    }
  } finally {
    cleanup(tempDir);
  }
});

test("findLetagentsConfig returns null for invalid JSON", () => {
  const tempDir = createTempDir();
  try {
    writeFileSync(join(tempDir, ".letagents.json"), "not valid json {{{");

    const originalError = console.error;
    console.error = () => {};
    try {
      const config = findLetagentsConfig(tempDir);
      assert.equal(config, null);
    } finally {
      console.error = originalError;
    }
  } finally {
    cleanup(tempDir);
  }
});

test("findLetagentsConfig trims whitespace from room name", () => {
  const tempDir = createTempDir();
  try {
    writeFileSync(
      join(tempDir, ".letagents.json"),
      JSON.stringify({ room: "  github.com/BrosInCode/letagents  " })
    );

    const config = findLetagentsConfig(tempDir);
    assert.deepEqual(config, { room: "github.com/BrosInCode/letagents" });
  } finally {
    cleanup(tempDir);
  }
});

// ── getRoomFromConfig ───────────────────────────────────

test("getRoomFromConfig returns room string when config exists", () => {
  const tempDir = createTempDir();
  try {
    writeFileSync(
      join(tempDir, ".letagents.json"),
      JSON.stringify({ room: "github.com/BrosInCode/letagents" })
    );

    const room = getRoomFromConfig(tempDir);
    assert.equal(room, "github.com/BrosInCode/letagents");
  } finally {
    cleanup(tempDir);
  }
});

test("getRoomFromConfig returns null when no config exists", () => {
  const tempDir = createTempDir();
  try {
    const room = getRoomFromConfig(tempDir);
    assert.equal(room, null);
  } finally {
    cleanup(tempDir);
  }
});

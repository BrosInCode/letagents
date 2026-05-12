import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { findLetagentsConfig, getRoomFromConfig } from "../config-reader.js";

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

function silenceConsoleError(): () => void {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
}

describe("findLetagentsConfig", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) cleanup(tempDir);
    tempDir = "";
  });

  it("returns config when .letagents.json is in the start directory", () => {
    tempDir = createTempDir();
    writeFileSync(
      join(tempDir, ".letagents.json"),
      JSON.stringify({ room: "github.com/BrosInCode/letagents" })
    );

    assert.deepEqual(findLetagentsConfig(tempDir), {
      room: "github.com/BrosInCode/letagents",
    });
  });

  it("walks up to find config in parent directory", () => {
    tempDir = createTempDir();
    const childDir = join(tempDir, "src", "mcp");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      join(tempDir, ".letagents.json"),
      JSON.stringify({ room: "gitlab.com/team/project" })
    );

    assert.deepEqual(findLetagentsConfig(childDir), {
      room: "gitlab.com/team/project",
    });
  });

  it("returns null when no config file exists", () => {
    tempDir = createTempDir();
    assert.equal(findLetagentsConfig(tempDir), null);
  });

  it("returns null for config with missing room field", () => {
    tempDir = createTempDir();
    writeFileSync(
      join(tempDir, ".letagents.json"),
      JSON.stringify({ version: "1.0" })
    );

    const restore = silenceConsoleError();
    try {
      assert.equal(findLetagentsConfig(tempDir), null);
    } finally {
      restore();
    }
  });

  it("returns null for config with empty room field", () => {
    tempDir = createTempDir();
    writeFileSync(
      join(tempDir, ".letagents.json"),
      JSON.stringify({ room: "" })
    );

    const restore = silenceConsoleError();
    try {
      assert.equal(findLetagentsConfig(tempDir), null);
    } finally {
      restore();
    }
  });

  it("returns null for invalid JSON", () => {
    tempDir = createTempDir();
    writeFileSync(join(tempDir, ".letagents.json"), "not valid json {{{");

    const restore = silenceConsoleError();
    try {
      assert.equal(findLetagentsConfig(tempDir), null);
    } finally {
      restore();
    }
  });

  it("trims whitespace from room name", () => {
    tempDir = createTempDir();
    writeFileSync(
      join(tempDir, ".letagents.json"),
      JSON.stringify({ room: "  github.com/BrosInCode/letagents  " })
    );

    assert.deepEqual(findLetagentsConfig(tempDir), {
      room: "github.com/BrosInCode/letagents",
    });
  });
});

describe("getRoomFromConfig", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) cleanup(tempDir);
    tempDir = "";
  });

  it("returns room string when config exists", () => {
    tempDir = createTempDir();
    writeFileSync(
      join(tempDir, ".letagents.json"),
      JSON.stringify({ room: "github.com/BrosInCode/letagents" })
    );

    assert.equal(getRoomFromConfig(tempDir), "github.com/BrosInCode/letagents");
  });

  it("returns null when no config exists", () => {
    tempDir = createTempDir();
    assert.equal(getRoomFromConfig(tempDir), null);
  });
});

import { findLetagentsConfig, getRoomFromConfig } from "../config-reader";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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

describe("findLetagentsConfig", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) cleanup(tempDir);
  });

  it("returns config when .letagents.json is in the start directory", () => {
    tempDir = createTempDir();
    writeFileSync(
      join(tempDir, ".letagents.json"),
      JSON.stringify({ room: "github.com/EmmyMay/letagents" })
    );

    const config = findLetagentsConfig(tempDir);
    expect(config).toEqual({ room: "github.com/EmmyMay/letagents" });
  });

  it("walks up to find config in parent directory", () => {
    tempDir = createTempDir();
    const childDir = join(tempDir, "src", "mcp");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      join(tempDir, ".letagents.json"),
      JSON.stringify({ room: "gitlab.com/team/project" })
    );

    const config = findLetagentsConfig(childDir);
    expect(config).toEqual({ room: "gitlab.com/team/project" });
  });

  it("returns null when no config file exists", () => {
    tempDir = createTempDir();
    const config = findLetagentsConfig(tempDir);
    expect(config).toBeNull();
  });

  it("returns null for config with missing room field", () => {
    tempDir = createTempDir();
    writeFileSync(
      join(tempDir, ".letagents.json"),
      JSON.stringify({ version: "1.0" })
    );

    // Suppress console.error for this test
    const spy = jest.spyOn(console, "error").mockImplementation();
    const config = findLetagentsConfig(tempDir);
    expect(config).toBeNull();
    spy.mockRestore();
  });

  it("returns null for config with empty room field", () => {
    tempDir = createTempDir();
    writeFileSync(
      join(tempDir, ".letagents.json"),
      JSON.stringify({ room: "" })
    );

    const spy = jest.spyOn(console, "error").mockImplementation();
    const config = findLetagentsConfig(tempDir);
    expect(config).toBeNull();
    spy.mockRestore();
  });

  it("returns null for invalid JSON", () => {
    tempDir = createTempDir();
    writeFileSync(join(tempDir, ".letagents.json"), "not valid json {{{");

    const spy = jest.spyOn(console, "error").mockImplementation();
    const config = findLetagentsConfig(tempDir);
    expect(config).toBeNull();
    spy.mockRestore();
  });

  it("trims whitespace from room name", () => {
    tempDir = createTempDir();
    writeFileSync(
      join(tempDir, ".letagents.json"),
      JSON.stringify({ room: "  github.com/EmmyMay/letagents  " })
    );

    const config = findLetagentsConfig(tempDir);
    expect(config).toEqual({ room: "github.com/EmmyMay/letagents" });
  });
});

describe("getRoomFromConfig", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) cleanup(tempDir);
  });

  it("returns room string when config exists", () => {
    tempDir = createTempDir();
    writeFileSync(
      join(tempDir, ".letagents.json"),
      JSON.stringify({ room: "github.com/EmmyMay/letagents" })
    );

    const room = getRoomFromConfig(tempDir);
    expect(room).toBe("github.com/EmmyMay/letagents");
  });

  it("returns null when no config exists", () => {
    tempDir = createTempDir();
    const room = getRoomFromConfig(tempDir);
    expect(room).toBeNull();
  });
});

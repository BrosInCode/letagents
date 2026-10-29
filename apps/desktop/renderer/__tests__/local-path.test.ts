import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isWindowsPlatform,
  joinLocalPath,
  localPathBasename,
  localPathDirname,
  localPathExamples,
} from "../src/domain/local-path";
import { rootPathLabel } from "../src/domain/sidebar-rooms";
import { projectRoomName } from "../src/domain/project-room-name";

describe("local-path: basename", () => {
  it("reads the last segment of POSIX paths", () => {
    assert.equal(localPathBasename("/Users/me/code/letagents"), "letagents");
    assert.equal(localPathBasename("/Users/me/code/letagents/"), "letagents");
    assert.equal(localPathBasename("~/Projects"), "Projects");
    assert.equal(localPathBasename("src/app.ts"), "app.ts");
    assert.equal(localPathBasename("app.ts"), "app.ts");
    // "//" starts a POSIX path, not a UNC root; names keep their spaces.
    assert.equal(localPathBasename("//usr/local"), "local");
    assert.equal(localPathBasename("dir/ name "), " name ");
  });

  it("reads the last segment of Windows drive, mixed and UNC paths", () => {
    assert.equal(localPathBasename("C:\\Users\\me\\code\\letagents"), "letagents");
    assert.equal(localPathBasename("C:\\Users\\me\\code\\letagents\\"), "letagents");
    assert.equal(localPathBasename("d:/work/letagents"), "letagents");
    assert.equal(localPathBasename("C:\\Users/me\\mixed"), "mixed");
    assert.equal(localPathBasename("\\\\server\\share\\team\\letagents"), "letagents");
    assert.equal(localPathBasename("src\\domain\\local-path.ts"), "local-path.ts");
  });

  it("returns an empty string for roots and empty input, so callers fall back", () => {
    for (const root of ["", "/", "C:\\", "C:", "c:/", "\\\\server\\share", "\\\\server\\share\\", null, undefined]) {
      assert.equal(localPathBasename(root), "", `root ${String(root)}`);
    }
  });
});

describe("local-path: dirname", () => {
  it("returns the parent of POSIX paths", () => {
    assert.equal(localPathDirname("/Users/me/code/letagents"), "/Users/me/code");
    assert.equal(localPathDirname("/Users"), "/");
    assert.equal(localPathDirname("src/domain/local-path.ts"), "src/domain");
    assert.equal(localPathDirname("app.ts"), "");
    assert.equal(localPathDirname("/"), "");
  });

  it("returns the parent of Windows paths with their own separators", () => {
    assert.equal(localPathDirname("C:\\Users\\me\\letagents"), "C:\\Users\\me");
    assert.equal(localPathDirname("C:\\Users"), "C:\\");
    assert.equal(localPathDirname("C:\\"), "");
    assert.equal(localPathDirname("d:/work/letagents/"), "d:/work");
    assert.equal(localPathDirname("\\\\server\\share\\team\\letagents"), "\\\\server\\share\\team");
    assert.equal(localPathDirname("src\\domain\\local-path.ts"), "src\\domain");
  });
});

describe("local-path: join and examples", () => {
  it("joins with the separator the folder already uses", () => {
    assert.equal(joinLocalPath("~/Projects", "notes", "MacIntel"), "~/Projects/notes");
    assert.equal(joinLocalPath("~/Projects/", "notes", "Win32"), "~/Projects/notes");
    assert.equal(joinLocalPath("C:\\Users\\me\\Projects\\", "notes", "MacIntel"), "C:\\Users\\me\\Projects\\notes");
    assert.equal(joinLocalPath("C:", "notes", "MacIntel"), "C:\\notes");
  });

  it("uses the platform separator for a bare folder name", () => {
    assert.equal(joinLocalPath("Projects", "notes", "Win32"), "Projects\\notes");
    assert.equal(joinLocalPath("Projects", "notes", "MacIntel"), "Projects/notes");
  });

  it("detects Windows and shows Windows example paths there", () => {
    assert.equal(isWindowsPlatform("win32"), true);
    assert.equal(isWindowsPlatform("Win32"), true);
    assert.equal(isWindowsPlatform("darwin"), false);
    assert.equal(isWindowsPlatform("MacIntel"), false);
    assert.equal(isWindowsPlatform("Linux x86_64"), false);
    assert.deepEqual(localPathExamples("Win32"), { parent: "C:\\Users\\you\\Projects", project: "C:\\Users\\you\\code\\my-project" });
    assert.deepEqual(localPathExamples("MacIntel"), { parent: "~/Projects", project: "~/code/my-project" });
  });
});

describe("local-path: room names from Windows project folders", () => {
  it("labels a Windows project root by its folder name", () => {
    assert.equal(rootPathLabel("C:\\Users\\me\\code\\letagents"), "letagents");
    assert.equal(rootPathLabel("/Users/me/code/letagents"), "letagents");
    assert.equal(rootPathLabel("C:\\"), null);
    assert.equal(projectRoomName({ rootPath: "C:\\Users\\me\\code\\pocket-notes" }), "pocket-notes");
  });
});

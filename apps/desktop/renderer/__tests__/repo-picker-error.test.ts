import assert from "node:assert/strict";
import test from "node:test";

import {
  GIT_NOT_FOUND_MESSAGE,
  GIT_NOT_FOUND_WINDOWS_MESSAGE,
  repoPickerErrorMessage,
} from "../src/domain/repo-picker-error";

const FALLBACK = "LetAgents could not open the repo picker.";

test("a missing Git becomes a step to take, with the Windows download on Windows", () => {
  const raw = new Error("Error invoking remote method 'desktop:repos:pick-room': Error: spawn git ENOENT");
  assert.equal(repoPickerErrorMessage(raw, FALLBACK, "win32"), GIT_NOT_FOUND_WINDOWS_MESSAGE);
  assert.equal(repoPickerErrorMessage(raw, FALLBACK, "Win32"), GIT_NOT_FOUND_WINDOWS_MESSAGE);
  assert.equal(repoPickerErrorMessage(raw, FALLBACK, "darwin"), GIT_NOT_FOUND_MESSAGE);
  assert.match(GIT_NOT_FOUND_WINDOWS_MESSAGE, /https:\/\/git-scm\.com\/download\/win/);
  // An absolute git.exe that is gone, and a result error string, read the same way.
  assert.equal(
    repoPickerErrorMessage("spawn C:\\Windows\\letagents-not-on-path\\git.exe ENOENT", FALLBACK, "win32"),
    GIT_NOT_FOUND_WINDOWS_MESSAGE,
  );
});

test("other errors lose only Electron's prefix", () => {
  assert.equal(
    repoPickerErrorMessage(new Error("Error invoking remote method 'desktop:repos:pick-room': Error: Finish or cancel the open folder picker first."), FALLBACK, "win32"),
    "Finish or cancel the open folder picker first.",
  );
  // A missing program that is not Git is not reported as a missing Git.
  assert.equal(repoPickerErrorMessage(new Error("spawn gh ENOENT"), FALLBACK, "win32"), "spawn gh ENOENT");
  assert.equal(repoPickerErrorMessage(null, FALLBACK, "win32"), FALLBACK);
  assert.equal(repoPickerErrorMessage(undefined, FALLBACK), FALLBACK);
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFocusRoomConclusionInput,
  canSubmitFocusRoomConclusion,
  createDefaultFocusRoomConclusionDetails,
} from "../src/domain/focus-room-conclusion";

describe("focus room conclusion input", () => {
  it("only requires a summary for an ad-hoc focus room", () => {
    const details = createDefaultFocusRoomConclusionDetails();
    assert.equal(canSubmitFocusRoomConclusion("", null, details), false);
    assert.equal(canSubmitFocusRoomConclusion("Finished the investigation.", null, details), true);
    assert.deepEqual(
      buildFocusRoomConclusionInput("  Finished the investigation.  ", null, details),
      { summary: "Finished the investigation.", details: null },
    );
  });

  it("requires and trims task-linked artifact and owner details", () => {
    const details = createDefaultFocusRoomConclusionDetails();
    assert.equal(canSubmitFocusRoomConclusion("Done", "task_12", details), false);
    details.artifact = "  PR #42  ";
    details.next_owner = "  Reviewer  ";
    assert.equal(canSubmitFocusRoomConclusion("Done", "task_12", details), true);
    assert.deepEqual(
      buildFocusRoomConclusionInput("  Done  ", "task_12", details),
      {
        summary: "Done",
        details: {
          artifact: "PR #42",
          review_state: "needs_review",
          blocker_state: "none",
          parent_task_next: "keep_open",
          next_owner: "Reviewer",
        },
      },
    );
  });
});

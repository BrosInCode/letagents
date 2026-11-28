import assert from "node:assert/strict";
import test from "node:test";

import { openModelLaunchFailureReason } from "../src/domain/open-model-launch-error";

test("openModelLaunchFailureReason extracts actionable Open Model setup errors and strips the scheduler prefix", () => {
  const cases = [
    "The model endpoint did not provide a context window for this model. Set its context window in Open Model settings, save it as the default model, and try again.",
    "The model endpoint rejected authentication (HTTP 401) while checking this model's context window. Check your API key in Open Model settings, or set its context window and save it as the default model, then try again.",
    "The model endpoint rejected authentication (HTTP 403) while checking this model's context window. Check your API key in Open Model settings, or set its context window and save it as the default model, then try again.",
    "The model context window must be a whole number of at least 2 tokens.",
    "The model endpoint URL is not a valid URL.",
    "The model endpoint URL must use http or https.",
    "The model endpoint URL must not contain credentials. Save the API key in the dedicated API key field instead.",
    "The model endpoint URL must not contain a fragment because fragments are exposed in process arguments.",
    "The model endpoint URL must not contain credential query parameters. Save the API key in the dedicated API key field instead.",
    "Open Model is waiting for its desktop-held endpoint credential.",
    "Waiting for desktop Open Model credential handoff.",
  ];
  for (const message of cases) {
    assert.equal(openModelLaunchFailureReason(`convergence scheduler failure: ${message}`, "open-model"), message);
    assert.equal(openModelLaunchFailureReason(message, "open_model"), message);
  }
});

test("openModelLaunchFailureReason ignores non-Open-Model providers and generic scheduler failures", () => {
  const reason = "The model endpoint did not provide a context window for this model. Set its context window in Open Model settings, save it as the default model, and try again.";
  for (const provider of ["codex", "claude", "claude-code", "cursor", "antigravity", ""]) {
    assert.equal(openModelLaunchFailureReason(`convergence scheduler failure: ${reason}`, provider), null, provider);
  }
  for (const other of [
    null,
    undefined,
    "",
    "convergence scheduler failure: spawn failed",
    "convergence scheduler failure: The saved OpenCode process is no longer running.",
    "convergence scheduler failure: internal write failed",
  ]) {
    assert.equal(openModelLaunchFailureReason(other, "open-model"), null, String(other));
  }
});

test("openModelLaunchFailureReason sanitizes control characters and redacts embedded credentials", () => {
  assert.equal(
    openModelLaunchFailureReason("convergence scheduler failure: The model endpoint URL failed: token=abc123secret\u0007", "open-model"),
    "The model endpoint URL failed: token=[redacted]",
  );
});

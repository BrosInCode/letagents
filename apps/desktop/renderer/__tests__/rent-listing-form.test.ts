import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildListingFormInput,
  canPauseListing,
  canResumeListing,
  ideKindLabel,
  LISTING_IDE_KINDS,
  resumeListingLabel,
  type ListingFormValues,
} from "../src/components/desktop/content/rent-listing-form";

function values(overrides: Partial<ListingFormValues> = {}): ListingFormValues {
  return {
    displayName: "Claude Code — evenings",
    ideKind: "claude_code",
    modelLabel: "",
    supportsScoped: true,
    supportsTrustedOpen: false,
    defaultLrtLimit: "",
    defaultTimeLimitMinutes: "",
    maxConcurrentSessions: 1,
    manualAcceptRequired: true,
    ...overrides,
  };
}

describe("buildListingFormInput", () => {
  it("shapes a minimal valid form into the IPC input", () => {
    const result = buildListingFormInput(values());
    assert.ok("input" in result);
    assert.deepStrictEqual(result.input, {
      displayName: "Claude Code — evenings",
      ideKind: "claude_code",
      modelLabel: null,
      supportedModes: ["scoped"],
      defaultLrtLimit: null,
      defaultTimeLimitMinutes: null,
      maxConcurrentSessions: 1,
      manualAcceptRequired: true,
    });
  });

  it("collects both modes and trims text fields", () => {
    const result = buildListingFormInput(values({
      displayName: "  Padded  ",
      modelLabel: "  sonnet-5  ",
      supportsTrustedOpen: true,
      defaultLrtLimit: 50_000,
      defaultTimeLimitMinutes: 60,
    }));
    assert.ok("input" in result);
    assert.strictEqual(result.input.displayName, "Padded");
    assert.strictEqual(result.input.modelLabel, "sonnet-5");
    assert.deepStrictEqual(result.input.supportedModes, ["scoped", "trusted_open"]);
    assert.strictEqual(result.input.defaultLrtLimit, 50_000);
    assert.strictEqual(result.input.maxConcurrentSessions, 1);
  });

  it("accepts concurrency within the cap and rejects above it", () => {
    const within = buildListingFormInput(values({ maxConcurrentSessions: 4 }));
    assert.ok("input" in within);
    assert.strictEqual(within.input.maxConcurrentSessions, 4);
    const above = buildListingFormInput(values({ maxConcurrentSessions: 5 }));
    assert.ok("error" in above && /limited to 4/.test(above.error));
  });

  it("rejects an empty display name", () => {
    const result = buildListingFormInput(values({ displayName: "   " }));
    assert.ok("error" in result);
  });

  it("rejects no access levels selected", () => {
    const result = buildListingFormInput(values({ supportsScoped: false }));
    assert.ok("error" in result && /access level/.test(result.error));
  });

  it("rejects non-positive or fractional numeric fields", () => {
    for (const overrides of [
      { defaultLrtLimit: 0 as const },
      { defaultTimeLimitMinutes: -5 as const },
      { maxConcurrentSessions: 1.5 as const },
      { maxConcurrentSessions: "" as const },
    ]) {
      const result = buildListingFormInput(values(overrides));
      assert.ok("error" in result, `expected error for ${JSON.stringify(overrides)}`);
    }
  });

  it("treats empty budget/time fields as unset (null), not errors", () => {
    const result = buildListingFormInput(values({
      defaultLrtLimit: "",
      defaultTimeLimitMinutes: "",
    }));
    assert.ok("input" in result);
    assert.strictEqual(result.input.defaultLrtLimit, null);
    assert.strictEqual(result.input.defaultTimeLimitMinutes, null);
  });
});

describe("listing action availability", () => {
  it("new listings (setup_required) can be activated via resume", () => {
    assert.ok(canResumeListing("setup_required"));
    assert.strictEqual(resumeListingLabel("setup_required"), "Activate");
  });
  it("paused listings resume; active listings pause", () => {
    assert.ok(canResumeListing("paused"));
    assert.strictEqual(resumeListingLabel("paused"), "Resume");
    assert.ok(canPauseListing("active"));
    assert.ok(!canPauseListing("paused"));
    assert.ok(!canResumeListing("active"));
    assert.ok(!canResumeListing("disabled"));
  });
});

describe("listing IDE kinds", () => {
  it("offers the supported IDE kinds with readable labels", () => {
    assert.ok(LISTING_IDE_KINDS.includes("claude_code"));
    assert.ok(!LISTING_IDE_KINDS.includes("antigravity"));
    assert.strictEqual(ideKindLabel("claude_code"), "Claude Code");
    assert.strictEqual(ideKindLabel("antigravity"), "Antigravity");
  });
});

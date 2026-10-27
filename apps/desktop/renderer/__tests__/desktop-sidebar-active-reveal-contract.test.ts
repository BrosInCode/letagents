import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const sidebarSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/sidebar/DesktopSidebar.vue",
  import.meta.url,
)), "utf8");

describe("desktop sidebar active room reveal contract", () => {
  it("brings the opened room's row into view whenever the open room changes", () => {
    assert.match(sidebarSource, /watch\(\(\) => props\.activeEntry\.id, \(entryId\) => requestActiveEntryReveal\(entryId\), \{ flush: "post" \}\);/);
    assert.match(sidebarSource, /onMounted\(\(\) => \{[^}]*requestActiveEntryReveal\(props\.activeEntry\.id\);/);
  });

  it("moves the list only as far as needed, so a row already on screen stays put", () => {
    const reveal = sidebarSource.match(/async function revealActiveEntry\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(reveal, /row\.scrollIntoView\(\{ block: "nearest", inline: "nearest", behavior: "instant" \}\)/);
  });

  it("opens the collapsed group that hides the row, and tries again when the room list arrives", () => {
    const reveal = sidebarSource.match(/async function revealActiveEntry\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(reveal, /if \(!row\) \{[\s\S]*?revealSearchResult\(entry\);[\s\S]*?await nextTick\(\);/);
    assert.match(sidebarSource, /watch\(\(\) => props\.projectEntries, \(\) => \{ if \(pendingActiveReveal\) void revealActiveEntry\(\); \}/);
  });

  it("reveals only rooms, not Inbox, Messages or Settings", () => {
    assert.match(sidebarSource, /pendingActiveReveal = props\.activeEntry\.type === "room" && entryId \? entryId : null;/);
  });
});

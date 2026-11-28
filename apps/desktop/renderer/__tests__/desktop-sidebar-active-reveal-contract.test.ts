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

  it("leaves a row already on screen in place and brings a hidden row to the middle of the list", () => {
    const reveal = sidebarSource.match(/async function revealActiveEntry\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(reveal, /revealRow\(row\);/);
    const revealRow = sidebarSource.match(/function revealRow\(row: HTMLElement\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(revealRow, /if \(list && sidebarRowFullyVisible\(row\.getBoundingClientRect\(\), list\.getBoundingClientRect\(\)\)\) return;/);
    assert.match(revealRow, /row\.scrollIntoView\(\{ block: list \? "center" : "nearest", inline: "nearest", behavior: "instant" \}\)/);
  });

  it("docks a copy of the open room at the list edge while its row is scrolled away", () => {
    assert.match(sidebarSource, /<div class="sidebar-room-sections" ref="roomSectionsElement" :data-dock-edge="activeRoomDock\.edge\.value \?\? undefined">/);
    assert.match(sidebarSource, /<SidebarActiveRoomDock[\s\S]*?:edge="activeRoomDock\.edge\.value"[\s\S]*?@reveal="activeRoomDock\.reveal"/);
    // A child room hidden in a collapsed group is stood in for by its project's row.
    assert.match(sidebarSource, /if \(row && !isClosingSidebarRow\(row\)\) return row;/);
    assert.match(sidebarSource, /return projectRow && !isClosingSidebarRow\(projectRow\) \? projectRow : null;/);
    // Closing groups and closing sections (Rooms, Pinned) both count, and a zen-mode collapse is watched.
    assert.match(sidebarSource, /row\.closest\("\.sidebar-reveal-leave-active, \.sidebar-pinned-reveal-leave-active"\)/);
    assert.match(sidebarSource, /\(\) => Boolean\(activeProject\.value && projectIsCollapsed\(activeProject\.value\.id\)\)/);
    // A drag scrolls the list near its edges, so the dock steps away while one runs.
    assert.match(sidebarSource, /enabled: \(\) => props\.activeEntry\.type === "room" && !props\.selectionActive && !dragState\.value/);
    // A focused row scrolls clear of the dock.
    assert.match(sidebarSource, /:data-dock-edge="activeRoomDock\.edge\.value \?\? undefined"/);
  });

  it("opens the folder of the project that holds the open room", () => {
    assert.equal(sidebarSource.match(/<FolderOpen v-if="activeProject\?\.id === project\.id" \/><Folder v-else \/>/g)?.length, 2);
    assert.equal(sidebarSource.match(/:data-holds-active="activeProject\?\.id === project\.id"/g)?.length, 2);
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

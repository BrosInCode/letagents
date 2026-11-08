import assert from "node:assert/strict";
import test from "node:test";
import { ref } from "vue";
import { useAppCompanyNavigation } from "../src/composables/app/useAppCompany";

test("company home opens the existing sidebar entry regardless of identifier casing", () => {
  const entry = { roomIdentifier: "GitHub.com/Herotel/App" };
  const opened: unknown[] = [];
  const app = {
    company: { rooms: ref([{ room_id: "github.com/herotel/app" }]) },
    sidebarProjectEntries: ref([{ parent: entry, branchRooms: [], focusRooms: [] }]),
    handleSidebarEntrySelected: (value: unknown) => opened.push(value),
  };
  const { openCompanyRoom } = useAppCompanyNavigation(app);
  openCompanyRoom("GITHUB.COM/herotel/app");
  assert.deepEqual(opened, [entry]);
  openCompanyRoom("github.com/other/private");
  assert.deepEqual(opened, [entry], "unlisted rooms cannot be opened through the company home");
});

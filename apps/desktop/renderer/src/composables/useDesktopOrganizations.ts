import { computed, ref, watch, type Ref } from "vue";
import type { DesktopAuthStatus } from "../../../electron/ipc-types/auth.js";
import type { DesktopOrganization, DesktopOrganizationRoom } from "../../../electron/ipc-types/organizations.js";
import { desktopIpc } from "../ipc/index.js";

export function useDesktopOrganizations(auth: Ref<DesktopAuthStatus | null>) {
  const organizations = ref<DesktopOrganization[]>([]);
  const rooms = ref<DesktopOrganizationRoom[]>([]);
  const selectedId = ref<string | null>(null);
  const busy = ref(false);
  const error = ref<string | null>(null);
  const selected = computed(() => organizations.value.find((org) => org.github_org_id === selectedId.value) ?? null);
  const accountKey = computed(() => auth.value?.authenticated && auth.value.account
    ? `letagents:company:${auth.value.apiUrl}:${auth.value.account.id}` : null);
  let generation = 0;

  function persist(): void {
    if (!accountKey.value) return;
    try {
      if (selectedId.value) window.localStorage.setItem(accountKey.value, selectedId.value);
      else window.localStorage.removeItem(accountKey.value);
    } catch { /* Selection still works when local storage is unavailable. */ }
  }

  async function refresh(): Promise<void> {
    if (!accountKey.value) return;
    const request = ++generation;
    busy.value = true;
    error.value = null;
    try {
      const next = await desktopIpc.organizations.list();
      if (request !== generation) return;
      organizations.value = next;
      if (selectedId.value && !next.some((org) => org.github_org_id === selectedId.value && org.joined)) {
        selectedId.value = null;
        rooms.value = [];
        persist();
      }
      if (selectedId.value) {
        const nextRooms = await desktopIpc.organizations.rooms(selectedId.value);
        if (request !== generation) return;
        rooms.value = nextRooms;
      }
    } catch {
      if (request === generation) {
        rooms.value = [];
        error.value = "Couldn’t verify your companies with GitHub. Retry, reconnect GitHub, or continue with personal rooms.";
      }
    } finally {
      if (request === generation) busy.value = false;
    }
  }

  async function choose(id: string | null): Promise<boolean> {
    if (!accountKey.value) return false;
    if (id === null) {
      generation += 1;
      selectedId.value = null;
      rooms.value = [];
      busy.value = false;
      error.value = null;
      persist();
      return true;
    }
    if (busy.value) return false;
    const org = organizations.value.find((item) => item.github_org_id === id);
    if (!org || (!org.setup && org.role !== "owner")) {
      error.value = "An organization owner needs to set up this company first.";
      return false;
    }
    const request = ++generation;
    busy.value = true;
    error.value = null;
    rooms.value = [];
    try {
      await desktopIpc.organizations.join(id, !org.setup);
      if (request !== generation) return false;
      org.setup = true;
      org.joined = true;
      selectedId.value = id;
      persist();
      const nextRooms = await desktopIpc.organizations.rooms(id);
      if (request !== generation) return false;
      rooms.value = nextRooms;
      return true;
    } catch {
      if (request === generation) error.value = "Couldn’t open this company. Retry to verify your GitHub access.";
      return false;
    } finally {
      if (request === generation) busy.value = false;
    }
  }

  watch(accountKey, () => {
    generation += 1;
    organizations.value = [];
    rooms.value = [];
    selectedId.value = null;
    busy.value = false;
    error.value = null;
    if (accountKey.value) {
      try { selectedId.value = window.localStorage.getItem(accountKey.value); } catch { /* Optional preference. */ }
      void refresh();
    }
  }, { immediate: true, flush: "sync" });

  return { organizations, rooms, selectedId, selected, busy, error, refresh, choose };
}

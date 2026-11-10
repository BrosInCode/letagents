import assert from "node:assert/strict";
import test from "node:test";
import { ref } from "vue";

import type { DesktopProjectBinding, DesktopProjectBindingMigrationResult } from "../../electron/ipc-types";
import { useAppProjectRepo } from "../src/composables/app/useAppProjectRepo";

function binding(rootPath: string): DesktopProjectBinding {
  return {
    id: "binding-1",
    identityKey: "project-room:github.com/acme/widgets",
    verificationKeys: ["project-room:github.com/acme/widgets"],
    aliases: ["project-room:github.com/acme/widgets", "room:github.com/acme/widgets"],
    rootPath,
    source: "git_remote",
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:01.000Z",
  };
}

test("a slow startup migration does not replace a binding that Connect project added meanwhile", async () => {
  let finishMigration!: (result: DesktopProjectBindingMigrationResult) => void;
  const migration = new Promise<DesktopProjectBindingMigrationResult>((resolve) => { finishMigration = resolve; });
  const connected = binding("/Users/me/widgets");
  let lists = 0;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      letagentsDesktop: {
        repos: {
          migrateProjectBindings: () => migration,
          listProjectBindings: async () => { lists += 1; return [connected]; },
        },
      },
      localStorage: { setItem: () => undefined, removeItem: () => undefined },
    },
  });
  try {
    const projectBindings = ref<DesktopProjectBinding[]>([]);
    const repo = useAppProjectRepo({
      authStatus: ref(null),
      legacyRepositoryRootBindings: {},
      legacyRepositoryRootBindingsStorageKey: "legacy",
      loading: ref(false),
      openAddAgentAfterRepoPick: ref(false),
      projectBindings,
      recentRootRooms: ref([]),
      repoStatus: ref(null),
      rootRoomSnapshot: ref(null),
      selectedRootRoomIdentifier: ref(null),
      sessionGeneration: ref(0),
    });
    const startup = repo.initializeProjectBindings();
    // Connect project finishes while the migration still runs.
    await repo.refreshProjectBindings();
    assert.deepEqual(projectBindings.value, [connected]);
    // The migration answers with the list it read before that write.
    finishMigration({ bindings: [], retryLegacyKeys: [] });
    await startup;
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    assert.deepEqual(projectBindings.value, [connected], "the older migration list is not shown");
    assert.equal(lists, 2, "the binding list is read again after the older migration result");
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
});

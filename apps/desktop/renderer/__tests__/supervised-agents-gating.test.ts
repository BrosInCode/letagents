import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ref } from "vue";

import {
  applySupervisedAgentsSupport,
  overrideSupervisedAgentsSupported,
  supervisedAgentsSupported,
  supervisedAgentsSupportedFromAppInfo,
  supervisedAgentsUnavailableNotice,
  thisComputerLabel,
} from "../src/domain/supervised-agents-support";
import {
  hostApprovalPollDue,
  hostApprovalRoom,
  refreshHostApprovals,
  resetHostApprovals,
} from "../src/components/desktop/content/room-chat/host-approvals";
import { useRoomShellSupervisorActions } from "../src/composables/room-shell/useRoomShellSupervisor";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
let daemonReads: string[] = [];

beforeEach(() => {
  daemonReads = [];
  resetHostApprovals();
  Object.assign(globalThis, { window: { letagentsDesktop: { supervisor: {
    listAgents: async () => { daemonReads.push("listAgents"); return []; },
    getStatus: async () => { daemonReads.push("getStatus"); throw new Error("unsupported"); },
    listHostApprovals: async () => { daemonReads.push("listHostApprovals"); return { available: false, approvals: [], error: "unsupported" }; },
  } } } });
});

afterEach(() => overrideSupervisedAgentsSupported(true));

describe("supervised agents support flag", () => {
  it("reads the main-process field, and assumes macOS only when an older main process omits it", () => {
    assert.equal(supervisedAgentsSupportedFromAppInfo({ platform: "win32", supervisedAgentsSupported: false }), false);
    assert.equal(supervisedAgentsSupportedFromAppInfo({ platform: "darwin", supervisedAgentsSupported: true }), true);
    assert.equal(supervisedAgentsSupportedFromAppInfo({ platform: "darwin", supervisedAgentsSupported: false }), false);
    assert.equal(supervisedAgentsSupportedFromAppInfo({ platform: "darwin" }), true);
    assert.equal(supervisedAgentsSupportedFromAppInfo({ platform: "win32" }), false);
    assert.equal(supervisedAgentsSupportedFromAppInfo({ platform: "linux" }), false);
  });

  it("updates the shared reactive flag from app info", () => {
    applySupervisedAgentsSupport({ platform: "win32", supervisedAgentsSupported: false });
    assert.equal(supervisedAgentsSupported.value, false);
    applySupervisedAgentsSupport({ platform: "darwin", supervisedAgentsSupported: true });
    assert.equal(supervisedAgentsSupported.value, true);
  });

  it("words the notice and the computer for the platform", () => {
    assert.equal(
      supervisedAgentsUnavailableNotice("Win32"),
      "Running agents from this app is coming to Windows. Chat, rooms and the board work now.",
    );
    assert.equal(thisComputerLabel("MacIntel"), "this Mac");
    assert.equal(thisComputerLabel("Win32"), "this PC");
    assert.equal(thisComputerLabel("Linux x86_64"), "this computer");
  });
});

describe("no daemon reads where agents cannot run", () => {
  it("host approvals never come due and never read the daemon", async () => {
    overrideSupervisedAgentsSupported(false);
    assert.equal(hostApprovalPollDue("room-a"), false);
    await refreshHostApprovals("room-a");
    assert.deepEqual(daemonReads, []);
    assert.equal(hostApprovalRoom("room-a").error ?? null, null);
  });

  it("the room's agent list settles empty and ready, with no error and no daemon read", async () => {
    overrideSupervisedAgentsSupported(false);
    const context = {
      props: { room: { identifier: "room-a" } },
      supervisorEntries: ref([{ id: "stale" }]),
      supervisorEntriesError: ref<string | null>("old error"),
      supervisorEntriesHaveLoaded: ref(false),
      supervisorEntriesState: ref("loading"),
      supervisorEntriesUpdatedAt: ref<string | null>(null),
      supervisorStatus: ref(null),
      supervisorSyncState: {
        supervisorEntriesRefreshOwnerActive: true,
        supervisorEntriesRefreshQueued: false,
        supervisorEntriesRefreshRequestId: 0,
        supervisorEntriesMutationVersion: 0,
        supervisorStatusRequestToken: 0,
        supervisorStateLastRepairAtMs: 0,
      },
    };
    const actions = useRoomShellSupervisorActions(context);
    await actions.refreshSupervisorEntries();
    assert.equal(await actions.refreshSupervisorStatus(), null);
    assert.deepEqual(daemonReads, []);
    assert.deepEqual(context.supervisorEntries.value, []);
    assert.equal(context.supervisorEntriesState.value, "ready");
    assert.equal(context.supervisorEntriesError.value, null);
    assert.equal(context.supervisorEntriesHaveLoaded.value, true);
  });

  it("still reads the daemon where agents run", async () => {
    overrideSupervisedAgentsSupported(true);
    assert.equal(hostApprovalPollDue("room-b"), true);
    await refreshHostApprovals("room-b");
    assert.deepEqual(daemonReads, ["listHostApprovals"]);
  });
});

describe("agent entry points show the one notice where agents cannot run", () => {
  it("Add agent opens the notice window instead of the setup window", () => {
    const shell = source("components/desktop/content/DesktopRoomShell.vue");
    assert.match(shell, /<AddAgentModal\s+v-if="supervisedAgentsSupported"/);
    assert.match(shell, /<AddAgentUnavailableModal v-else :open="addAgentModalOpen"/);
    assert.match(source("components/desktop/content/AddAgentUnavailableModal.vue"), /<SupervisedAgentsUnavailableNotice \/>/);
  });

  it("the composer's Add agent opens that window instead of listing providers", () => {
    assert.match(
      source("components/desktop/content/room-chat/RoomComposer.vue"),
      /:agent-rows="agentHost && supervisedAgentsSupported \? agentRows : null"/,
    );
  });

  it("Give an agent, renting out and agent settings show the notice", () => {
    const give = source("components/desktop/content/asks/GiveAgentDialog.vue");
    assert.match(give, /v-if="!supervisedAgentsSupported"[\s\S]*<SupervisedAgentsUnavailableNotice \/>/);
    assert.match(give, /if \(!token \|\| !supervisedAgentsSupported\.value\) return;/);
    const settings = source("components/desktop/content/SettingsView.vue");
    assert.match(settings, /v-else-if="!supervisedAgentsSupported && agentOnlySettingsPanes\.has\(activePane\)"/);
    assert.match(settings, /\["account:renting", "system:supervisor", "system:diagnostics"\]/);
    assert.match(source("components/desktop/content/RentMarketplaceView.vue"), /<RentProviderDashboard v-if="supervisedAgentsSupported" \/>\s*<SupervisedAgentsUnavailableNotice v-else \/>/);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { ref } from "vue";
import type {
  DesktopAgentProviderId,
  DesktopAgentProviderModelsResult,
  DesktopManagedAgentEffort,
} from "../../electron/ipc-types";
import {
  modelCliUpdateNote,
  useAddAgentPresentation,
} from "../src/components/desktop/content/add-agent/useAddAgentPresentation";

const update = { modelLabels: ["Fable 5.2"], installedVersion: "2.1.311", command: "claude update" };

test("the note names the missing models, the installed version and the command", () => {
  assert.equal(modelCliUpdateNote(null, "Claude Code"), null);
  assert.equal(modelCliUpdateNote({ ...update, modelLabels: [] }, "Claude Code"), null);
  assert.deepEqual(modelCliUpdateNote(update, "Claude Code"),
    { message: "Fable 5.2 needs a newer Claude Code (installed: 2.1.311).", command: "claude update" });
  assert.equal(modelCliUpdateNote({ ...update, modelLabels: ["Fable 5.2", "Opus 5.5", "Haiku 5.5"], installedVersion: "2.1.278" }, "Claude Code")?.message,
    "Fable 5.2, Opus 5.5 and Haiku 5.5 need a newer Claude Code (installed: 2.1.278).");
});

function presentation(models: DesktopAgentProviderModelsResult | null) {
  const providerModels = ref(models);
  const loadingProviderModels = ref(false);
  const configuration = {
    supervisedCharter: ref(""),
    providerModels,
    loadingProviderModels,
    selectedModelMode: ref<"default" | "option" | "custom">("default"),
    selectedProviderModelId: ref(""),
    customModelId: ref(""),
    selectedEffort: ref<DesktopManagedAgentEffort | "">(""),
    selectedPermissionProfileId: ref(null),
  };
  const setup = {
    providers: ref([{ id: "claude-code", name: "Claude Code", capabilities: ["supervised_runtime"], permissionProfiles: [] }]),
    selectedProviderId: ref<DesktopAgentProviderId | null>("claude-code"),
    preflight: ref(null),
    secureStorageStatus: ref(null),
    loadingProviders: ref(false),
    loadingPreflight: ref(false),
    creatingWorktree: ref(false),
    setupConfirmation: ref(null),
    loadError: ref(null),
  };
  const view = useAddAgentPresentation({
    roomIdentifier: "room-1",
    roomGitRoom: null,
    gitRoomMatchesActiveRepo: false,
    roomDisplayName: null,
    repoRootPath: null,
    repoStatus: null,
  }, setup as never, configuration as never);
  return { view, providerModels, loadingProviderModels };
}

const claudeList = (extra: Partial<DesktopAgentProviderModelsResult> = {}): DesktopAgentProviderModelsResult => ({
  providerId: "claude-code",
  status: "ready",
  models: [{ id: "claude-fable-5-1", label: "Fable 5.1", source: "known" }],
  defaultModel: null,
  error: null,
  ...extra,
});

test("the Add agent view shows the note from the model list, keeps it while refreshing, and gives way to an error", () => {
  const { view, providerModels, loadingProviderModels } = presentation(claudeList({ cliUpdate: update }));
  assert.equal(view.providerModelCliUpdate.value?.message, "Fable 5.2 needs a newer Claude Code (installed: 2.1.311).");

  loadingProviderModels.value = true;
  assert.equal(view.providerModelCliUpdate.value?.command, "claude update", "a refresh does not make the footer jump");
  loadingProviderModels.value = false;

  providerModels.value = claudeList({ cliUpdate: update, error: "Claude Code did not answer." });
  assert.equal(view.providerModelCliUpdate.value, null);
  providerModels.value = claudeList();
  assert.equal(view.providerModelCliUpdate.value, null, "a current CLI shows nothing");
  providerModels.value = null;
  assert.equal(view.providerModelCliUpdate.value, null);
});

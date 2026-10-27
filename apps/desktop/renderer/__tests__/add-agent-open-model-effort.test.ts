import assert from "node:assert/strict";
import test from "node:test";
import { ref } from "vue";
import type {
  DesktopAgentProviderId,
  DesktopAgentProviderModelsResult,
  DesktopManagedAgentEffort,
} from "../../electron/ipc-types";
import {
  managedAgentEffortOptionsForProvider,
  useAddAgentPresentation,
} from "../src/components/desktop/content/add-agent/useAddAgentPresentation";

test("Open Model offers exactly the efforts its endpoint lists for the model", () => {
  const values = (supportedEfforts?: DesktopManagedAgentEffort[]) =>
    managedAgentEffortOptionsForProvider("open-model", { id: "m", label: "m", source: "known", ...(supportedEfforts ? { supportedEfforts } : {}) })
      .map((option) => option.value);
  assert.deepEqual(values(["low", "medium", "high"]), ["low", "medium", "high"]);
  assert.deepEqual(values(["xhigh", "low"]), ["low", "xhigh"]);
  assert.deepEqual(values(["max" as DesktopManagedAgentEffort]), [], "Claude's max is never an Open Model choice");
  assert.deepEqual(values([]), []);
  assert.deepEqual(values(), []);
  assert.deepEqual(managedAgentEffortOptionsForProvider("open-model", null), []);
  assert.deepEqual(managedAgentEffortOptionsForProvider("codex").map((option) => option.value), ["low", "medium", "high", "xhigh"]);
});

function presentation() {
  const selectedProviderId = ref<DesktopAgentProviderId | null>("open-model");
  const providerModels = ref<DesktopAgentProviderModelsResult | null>({
    providerId: "open-model",
    status: "ready",
    defaultModel: "openai/gpt-oss-120b",
    error: null,
    models: [
      { id: "openai/gpt-oss-120b", label: "openai/gpt-oss-120b (saved)", isDefault: true, source: "known", supportedEfforts: ["low", "medium", "high"] },
      { id: "openai/gpt-5-mini", label: "openai/gpt-5-mini", source: "provider", supportedEfforts: ["low", "medium"] },
      { id: "qwen/qwen3-coder", label: "qwen/qwen3-coder", source: "provider" },
    ],
  });
  const configuration = {
    supervisedCharter: ref(""),
    providerModels,
    loadingProviderModels: ref(false),
    selectedModelMode: ref<"default" | "option" | "custom">("default"),
    selectedProviderModelId: ref(""),
    customModelId: ref(""),
    selectedEffort: ref<DesktopManagedAgentEffort | "">(""),
    selectedPermissionProfileId: ref(null),
  };
  const setup = {
    providers: ref([]),
    selectedProviderId,
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
  return { view, configuration, selectedProviderId };
}

test("the Add agent effort selector follows the selected Open Model model", () => {
  const { view, configuration, selectedProviderId } = presentation();
  // The saved model is the default choice and lists three efforts.
  assert.equal(view.showEffortSelector.value, true);
  assert.deepEqual(view.effortSelectOptions.value.map((option) => option.value), ["", "low", "medium", "high"]);
  assert.equal(view.effortSelectOptions.value[0]?.label, "Use provider default");

  configuration.selectedEffort.value = "high";
  configuration.selectedModelMode.value = "option";
  configuration.selectedProviderModelId.value = "openai/gpt-5-mini";
  assert.deepEqual(view.effortSelectOptions.value.map((option) => option.value), ["", "low", "medium"]);
  assert.equal(configuration.selectedEffort.value, "", "an effort the new model lacks goes back to the default");

  configuration.selectedEffort.value = "medium";
  configuration.selectedModelMode.value = "default";
  assert.equal(configuration.selectedEffort.value, "medium", "an effort the new model lists is kept");

  configuration.selectedModelMode.value = "option";
  configuration.selectedProviderModelId.value = "qwen/qwen3-coder";
  assert.equal(view.showEffortSelector.value, false, "a model without a list has no selector");
  assert.equal(configuration.selectedEffort.value, "");

  configuration.selectedModelMode.value = "custom";
  configuration.customModelId.value = "openai/gpt-oss-120b";
  assert.equal(view.showEffortSelector.value, false, "a custom id has no catalog entry");

  selectedProviderId.value = "claude-code";
  assert.equal(view.showEffortSelector.value, true, "Claude Code passes its effort as --effort");
  selectedProviderId.value = "codex";
  assert.equal(view.showEffortSelector.value, true);
});

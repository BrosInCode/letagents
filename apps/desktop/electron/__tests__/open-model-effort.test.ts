import assert from "node:assert/strict";
import test from "node:test";

import { openModelModelsResult } from "../main/agents/managed-agent-models.js";
import {
  clearOpenModelEffortCatalogCacheForTest,
  parseOpenModelSupportedEfforts,
  resolveOpenModelEffortCatalog,
} from "../main/agents/open-model-efforts.js";
import { openCodeConfig, OPEN_MODEL_OPENCODE_PROVIDER_ID } from "../main/agents/opencode-launch-contract.js";
import { attestProviderSpawnPolicy } from "../main/agents/provider-spawn-configuration.js";

// Shapes from OpenRouter's GET /api/v1/models on 2026-10-26.
const openRouterModels = {
  data: [
    {
      id: "openai/gpt-oss-120b",
      supported_parameters: ["reasoning", "reasoning_effort", "tools"],
      reasoning: { supported_efforts: ["low", "medium", "high"], default_effort: "medium", mandatory: false },
    },
    {
      id: "openai/gpt-5-mini",
      supported_parameters: ["reasoning", "reasoning_effort", "tools"],
      reasoning: { supported_efforts: ["minimal", "low", "medium", "high"], default_effort: "medium", mandatory: true },
    },
    { id: "qwen/qwen3-coder", supported_parameters: ["tools"] },
    { id: "z-ai/glm-4.6", supported_parameters: ["reasoning", "tools"], reasoning: { mandatory: false } },
  ],
};

test("only OpenRouter's reasoning.supported_efforts lists a model's efforts", () => {
  const efforts = parseOpenModelSupportedEfforts(openRouterModels);
  assert.deepEqual(efforts.get("openai/gpt-oss-120b"), ["low", "medium", "high"]);
  // "minimal" is not a value the daemon stores, so it is never offered.
  assert.deepEqual(efforts.get("openai/gpt-5-mini"), ["low", "medium", "high"]);
  assert.equal(efforts.has("qwen/qwen3-coder"), false);
  assert.equal(efforts.has("z-ai/glm-4.6"), false);

  // Other endpoints (vLLM, Ollama, LM Studio) and odd shapes support none.
  assert.equal(parseOpenModelSupportedEfforts({ data: [{ id: "qwen", max_model_len: 32768 }] }).size, 0);
  assert.equal(parseOpenModelSupportedEfforts({ data: [{ id: "m", supported_parameters: ["reasoning_effort"] }] }).size, 0);
  assert.equal(parseOpenModelSupportedEfforts({ data: [{ id: "m", reasoning: { supported_efforts: "high" } }] }).size, 0);
  assert.equal(parseOpenModelSupportedEfforts({ data: [{ id: "m", reasoning: { supported_efforts: ["max", "none"] } }] }).size, 0);
  assert.equal(parseOpenModelSupportedEfforts({ models: openRouterModels.data }).size, 0);
  assert.equal(parseOpenModelSupportedEfforts(null).size, 0);
  // Canonical order, whatever order the endpoint lists.
  assert.deepEqual(parseOpenModelSupportedEfforts({ data: [{ id: "m", reasoning: { supported_efforts: ["xhigh", "low"] } }] }).get("m"), ["low", "xhigh"]);
});

test("the effort catalog is read once per endpoint and key, and a failure means no support", async () => {
  clearOpenModelEffortCatalogCacheForTest();
  const calls: Array<{ url: string; authorization: string | undefined }> = [];
  let clock = 1_000;
  let answer: () => Response = () => Response.json(openRouterModels);
  const fetchModels = async (url: string, init?: RequestInit) => {
    calls.push({ url, authorization: (init?.headers as Record<string, string> | undefined)?.Authorization });
    return answer();
  };
  const endpoint = { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-test" };

  const first = await resolveOpenModelEffortCatalog(endpoint, fetchModels, () => clock);
  assert.deepEqual(first.get("openai/gpt-oss-120b"), ["low", "medium", "high"]);
  assert.deepEqual(calls, [{ url: "https://openrouter.ai/api/v1/models", authorization: "Bearer sk-test" }]);

  await resolveOpenModelEffortCatalog(endpoint, fetchModels, () => clock);
  assert.equal(calls.length, 1, "a fresh answer is reused");
  await resolveOpenModelEffortCatalog({ ...endpoint, apiKey: "sk-other" }, fetchModels, () => clock);
  assert.equal(calls.length, 2, "another key reads again");

  answer = () => new Response("down", { status: 503 });
  const refreshed = await resolveOpenModelEffortCatalog({ ...endpoint, refresh: true }, fetchModels, () => clock);
  assert.equal(calls.length, 3, "a refresh reads again");
  assert.equal(refreshed.size, 0, "a failed answer is no support");

  answer = () => Response.json(openRouterModels);
  clock += 16_000;
  assert.equal((await resolveOpenModelEffortCatalog(endpoint, fetchModels, () => clock)).size, 2, "a failure is kept only briefly");

  const thrown = await resolveOpenModelEffortCatalog(
    { baseUrl: "https://example.test/v1", apiKey: null },
    async () => { throw new Error("Bearer sk-secret refused"); },
  );
  assert.equal(thrown.size, 0);
  assert.equal((await resolveOpenModelEffortCatalog({ baseUrl: "not a url", apiKey: null }, fetchModels)).size, 0);
  clearOpenModelEffortCatalogCacheForTest();
});

test("the Open Model catalog gives each model the efforts its endpoint lists", () => {
  const efforts = parseOpenModelSupportedEfforts(openRouterModels);
  const saved = openModelModelsResult({ model: "openai/gpt-oss-120b" }, {}, efforts);
  assert.deepEqual(saved.models, [{
    id: "openai/gpt-oss-120b",
    label: "openai/gpt-oss-120b (saved)",
    isDefault: true,
    source: "known",
    supportedEfforts: ["low", "medium", "high"],
  }]);

  const chosen = openModelModelsResult({ model: "openai/gpt-oss-120b" }, { model: "qwen/qwen3-coder", modelSource: "custom" }, efforts);
  assert.equal(chosen.models[1]?.id, "qwen/qwen3-coder");
  assert.equal(Object.hasOwn(chosen.models[1]!, "supportedEfforts"), false, "a model without a list takes no effort");
});

function config(reasoningEffort?: "low" | "medium" | "high" | "xhigh" | null) {
  const built = openCodeConfig({
    model: "openai/gpt-oss-120b",
    limits: { context: 131_072, output: 8_192 },
    baseUrl: "https://openrouter.ai/api/v1",
    pluginUrl: "file:///runtime/credential-boundary.mjs",
    cwd: "/workspace",
    mcpCommand: ["npx", "-y", "letagents"],
    mcpEnvironment: {},
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  });
  const provider = (built.provider as Record<string, { models: Record<string, { options: unknown }> }>)[OPEN_MODEL_OPENCODE_PROVIDER_ID]!;
  return provider.models["openai/gpt-oss-120b"]!.options;
}

test("the launch writes the chosen effort into the OpenCode model options, and nothing for the default", () => {
  assert.deepEqual(config("high"), { reasoningEffort: "high" });
  assert.deepEqual(config(null), {});
  assert.deepEqual(config(), {});
});

test("an Open Model launch may carry an OpenAI-compatible effort, never Claude's max", () => {
  const request = {
    launchPolicy: { permission: { "*": "allow" } },
    permissionProfileId: "full_access",
    configurationRevision: 3,
  };
  for (const reasoningEffort of ["low", "medium", "high", "xhigh"] as const) {
    assert.deepEqual(attestProviderSpawnPolicy("open-model", { ...request, reasoningEffort } as never), { permission: { "*": "allow" } });
  }
  assert.throws(() => attestProviderSpawnPolicy("open-model", { ...request, reasoningEffort: "max" } as never), /does not support the selected reasoning effort/);
});

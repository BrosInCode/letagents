import { unary } from "../connect-rpc.mjs";
import {
  parseTrajectorySummaries,
  pickActiveCascadeIdFromMap,
} from "../cascade-parsing.mjs";
import { pickWorkspaceModel } from "../cascade-client.mjs";

export async function listCascades({ baseUrl, csrf }) {
  const result = await unary(baseUrl, csrf, "GetAllCascadeTrajectories", {});
  if (result.status !== 200) {
    throw new Error(
      `GetAllCascadeTrajectories: HTTP ${result.status} ${result.text.slice(0, 400)}`,
    );
  }

  const summaries = parseTrajectorySummaries(result.parsed);
  console.log(
    JSON.stringify(
      {
        raw: result.parsed,
        parsedSummaries: Object.fromEntries(summaries),
        pickedActive: pickActiveCascadeIdFromMap(summaries) || null,
      },
      null,
      2,
    ),
  );
}

export async function resolveModelId({
  env,
  direct,
  targetKind,
  baseUrl,
  csrf,
  log,
}) {
  if (env.ANTIGRAVITY_MODEL) return env.ANTIGRAVITY_MODEL;

  if (direct) return "MODEL_GOOGLE_GEMINI_2_5_FLASH";
  if (targetKind === "workspace") {
    return pickWorkspaceModel(baseUrl, csrf, log);
  }

  return "MODEL_CLAUDE_4_OPUS";
}

export async function listModels({ targetKind, baseUrl, csrf }) {
  const method =
    targetKind === "workspace"
      ? "GetCascadeModelConfigData"
      : "GetCascadeModelConfigs";
  const result = await unary(baseUrl, csrf, method, {});
  if (result.status !== 200) {
    throw new Error(`${method}: ${result.status} ${result.text}`);
  }

  const empty =
    !result.parsed ||
    (typeof result.parsed === "object" && Object.keys(result.parsed).length === 0);
  if (empty) {
    console.error(
      `${method} returned an empty object (no \`clientModelConfigs\` in this session).`,
    );
    console.error(
      "For `--direct`, unset ANTIGRAVITY_MODEL to use the script default (a `MODEL_GOOGLE_GEMINI_*` enum from the LS binary), or set ANTIGRAVITY_MODEL yourself.",
    );
  }

  console.log(JSON.stringify(result.parsed, null, 2));
}

export async function runDirectResponse({
  baseUrl,
  csrf,
  prompt,
  modelId,
  jsonOut,
}) {
  const result = await unary(baseUrl, csrf, "GetModelResponse", {
    prompt,
    model: modelId,
  });
  if (result.status !== 200 || !result.parsed?.response) {
    throw new Error(
      `GetModelResponse: ${result.status} ${result.text}\n` +
        "Hint: set ANTIGRAVITY_MODEL to a Gemini enum from `node headless_antigravity_worker.mjs --list-models` (UI model choice alone does not change this flag).",
    );
  }

  if (jsonOut) {
    console.log(JSON.stringify(result.parsed, null, 2));
    return;
  }

  console.log(String(result.parsed.response).trim());
}

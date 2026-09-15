import { execFile } from "node:child_process";
import { resolve } from "node:path";

import type {
  DesktopAgentProviderId,
  DesktopAgentProviderModelOption,
  DesktopAgentProviderModelSource,
  DesktopAgentProviderModelsResult,
  DesktopAgentProviderPreflightInput,
  DesktopManagedAgentEffort,
} from "../../ipc-types.js";
import { resolveCodexExecutable } from "./codex-executable.js";
import { validateCodexDefaultModel } from "./codex-default-model.js";
import { normalizeCursorMcpPolicy, prepareCursorManagedProfile } from "./cursor-managed-profile.js";
import { buildCursorChildEnv } from "./cursor-runner.js";
import { readOpenModelSettings } from "./open-model-settings.js";
import { desktopRuntimeEnvironment, desktopShellEnvironmentReady } from "../desktop-shell-environment.js";

type ModelListCacheEntry = {
  expiresAt: number;
  result: DesktopAgentProviderModelsResult;
};

type ExecResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
};

type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

const MODEL_LIST_CACHE_MS = 60_000;
const MODEL_LIST_ERROR_CACHE_MS = 10_000;
const MODEL_LIST_TIMEOUT_MS = 10_000;
const MODEL_LIST_MAX_BUFFER = 8 * 1024 * 1024;
const modelListCache = new Map<string, ModelListCacheEntry>();

const CLAUDE_CODE_KNOWN_MODELS: DesktopAgentProviderModelOption[] = [
  // Full model id on purpose: shipped Claude Code CLIs reject the bare
  // "fable" alias ("issue with the selected model"), while full ids pass
  // through to the API on every CLI version.
  { id: "claude-fable-5", label: "Fable 5", source: "known" },
  { id: "opus", label: "Opus (latest)", source: "known" },
  { id: "sonnet", label: "Sonnet (latest)", source: "known" },
  { id: "haiku", label: "Haiku (latest)", source: "known" },
  { id: "best", label: "Best available", source: "known" },
  { id: "opusplan", label: "Opus Plan", source: "known" },
  { id: "sonnet[1m]", label: "Sonnet 1M", source: "known" },
  { id: "opus[1m]", label: "Opus 1M", source: "known" },
];

export function normalizeManagedAgentModel(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function normalizeManagedAgentModelSource(
  value: DesktopAgentProviderModelSource | null | undefined,
): DesktopAgentProviderModelSource {
  return value === "provider" || value === "known" || value === "custom"
    ? value
    : "custom";
}

export function normalizeManagedAgentEffort(
  value: DesktopManagedAgentEffort | string | null | undefined,
): DesktopManagedAgentEffort | null {
  const normalized = String(value ?? "").trim();
  return normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh" ||
    normalized === "max"
    ? normalized
    : null;
}

export function normalizeManagedAgentEffortForProvider(
  providerId: DesktopAgentProviderId,
  value: DesktopManagedAgentEffort | string | null | undefined,
): DesktopManagedAgentEffort | null {
  const effort = normalizeManagedAgentEffort(value);
  if (!effort) return null;
  if (providerId === "claude-code") return effort;
  if (providerId === "codex") return effort === "max" ? null : effort;
  return null;
}

export async function listDesktopAgentProviderModels(
  providerId: DesktopAgentProviderId,
  input: DesktopAgentProviderPreflightInput = {},
): Promise<DesktopAgentProviderModelsResult> {
  await desktopShellEnvironmentReady();
  if (providerId === "cursor") {
    return listCursorModels(input);
  }
  if (providerId === "claude-code") {
    return modelResult(providerId, "ready", CLAUDE_CODE_KNOWN_MODELS, null, null);
  }
  if (providerId === "codex") {
    return listCodexModels(input);
  }
  if (providerId === "open-model") {
    return listOpenModelModels(input);
  }
  return modelResult(providerId, "unavailable", [], null, "Model selection is only available for desktop-managed agents.");
}

async function listCodexModels(
  input: DesktopAgentProviderPreflightInput,
): Promise<DesktopAgentProviderModelsResult> {
  const runtimeEnv = desktopRuntimeEnvironment();
  const command = resolveCodexExecutable({ env: runtimeEnv });
  const cacheKey = `codex:${command}`;
  const forceRefresh = Boolean(input.refreshModels);
  const cached = modelListCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cloneModelResult(cached.result);
  }

  const refreshed = await execFileWithTimeout(command, ["debug", "models"], { env: runtimeEnv });
  let models = parseCodexModelsOutput(refreshed.stdout);
  let next: DesktopAgentProviderModelsResult | null = null;
  if (refreshed.ok && models.length) {
    next = modelResult("codex", "ready", models, codexDefaultModel(models), null);
  } else {
    const bundled = await execFileWithTimeout(command, ["debug", "models", "--bundled"], { env: runtimeEnv });
    models = parseCodexModelsOutput(bundled.stdout);
    next = bundled.ok && models.length
      ? modelResult("codex", "ready", models, codexDefaultModel(models), null)
      : modelResult(
        "codex",
        refreshed.ok || bundled.ok ? "unavailable" : "error",
        [],
        null,
        firstNonEmptyLine(refreshed.stderr) ||
          firstNonEmptyLine(bundled.stderr) ||
          refreshed.error ||
          bundled.error ||
          "Codex did not return any models.",
      );
  }

  if (!forceRefresh && next.status !== "ready" && cached?.result.status === "ready") {
    return refreshStaleReadyModelCache(cacheKey, cached);
  }

  cacheModelListResult(cacheKey, next);
  return cloneModelResult(next);
}

export async function validateDesktopManagedAgentModel(input: {
  providerId: DesktopAgentProviderId;
  model?: string | null;
  modelSource?: DesktopAgentProviderModelSource | null;
  repoRootPath?: string | null;
  cursorMcpPolicy?: DesktopAgentProviderPreflightInput["cursorMcpPolicy"];
}): Promise<{ model: string | null; error: string | null }> {
  const model = normalizeManagedAgentModel(input.model);
  if (!model) {
    if (input.providerId === "codex") {
      await desktopShellEnvironmentReady();
      const env = desktopRuntimeEnvironment();
      return { model: null, error: await validateCodexDefaultModel({
        command: resolveCodexExecutable({ env }), env,
        cwd: input.repoRootPath?.trim() || undefined,
      }) };
    }
    return { model: null, error: null };
  }

  const source = normalizeManagedAgentModelSource(input.modelSource);
  if (source === "custom") {
    return { model, error: null };
  }

  const result = await listDesktopAgentProviderModels(input.providerId, input);
  if (result.status !== "ready") {
    return {
      model,
      error: result.error || `Could not verify ${providerLabel(input.providerId)} model '${model}'.`,
    };
  }

  if (source === "provider") {
    const exists = result.models.some((option) =>
      option.source === "provider" && option.id === model
    );
    return exists
      ? { model, error: null }
      : {
        model,
        error: `${providerLabel(input.providerId)} model '${model}' is no longer available. Choose another model or use a custom model id.`,
      };
  }

  const known = result.models.some((option) =>
    option.source === "known" && option.id === model
  );
  return known || input.providerId === "open-model"
    ? { model, error: null }
    : {
      model,
      error: `${providerLabel(input.providerId)} model '${model}' is not in the known model list. Use Custom model id to pass it through anyway.`,
    };
}

function modelResult(
  providerId: DesktopAgentProviderId,
  status: DesktopAgentProviderModelsResult["status"],
  models: DesktopAgentProviderModelOption[],
  defaultModel: string | null,
  error: string | null,
): DesktopAgentProviderModelsResult {
  return {
    providerId,
    status,
    models: models.map((model) => ({ ...model })),
    defaultModel,
    error,
  };
}

async function listCursorModels(
  input: DesktopAgentProviderPreflightInput,
): Promise<DesktopAgentProviderModelsResult> {
  const command = process.env.LETAGENTS_CURSOR_AGENT_BIN || "cursor-agent";
  const context = cursorModelExecutionContext(input);
  if (context.error) {
    return modelResult("cursor", "error", [], null, context.error);
  }
  const cacheKey = `cursor:${command}:${context.cacheKey}`;
  const forceRefresh = Boolean(input.refreshModels);
  const cached = modelListCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cloneModelResult(cached.result);
  }

  const result = await execFileWithTimeout(command, ["models"], {
    cwd: context.cwd,
    env: context.env,
  });
  const models = parseCursorModelsOutput(result.stdout);
  const next = result.ok && models.length
    ? modelResult("cursor", "ready", models, cursorDefaultModel(models), null)
    : modelResult(
      "cursor",
      result.ok ? "unavailable" : "error",
      [],
      null,
      firstNonEmptyLine(result.stderr) || result.error || "Cursor did not return any models.",
    );

  if (!forceRefresh && next.status !== "ready" && cached?.result.status === "ready") {
    return refreshStaleReadyModelCache(cacheKey, cached);
  }

  cacheModelListResult(cacheKey, next);
  return cloneModelResult(next);
}

function cacheModelListResult(
  cacheKey: string,
  result: DesktopAgentProviderModelsResult,
): void {
  modelListCache.set(cacheKey, {
    expiresAt: Date.now() + (result.status === "ready" ? MODEL_LIST_CACHE_MS : MODEL_LIST_ERROR_CACHE_MS),
    result,
  });
}

function refreshStaleReadyModelCache(
  cacheKey: string,
  cached: ModelListCacheEntry,
): DesktopAgentProviderModelsResult {
  modelListCache.set(cacheKey, {
    expiresAt: Date.now() + MODEL_LIST_ERROR_CACHE_MS,
    result: cached.result,
  });
  return cloneModelResult(cached.result);
}

function cursorModelExecutionContext(input: DesktopAgentProviderPreflightInput): {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  cacheKey: string;
  error: string | null;
} {
  const workspaceRoot = normalizeOptionalPath(input.repoRootPath);
  const resolvedWorkspaceRoot = workspaceRoot ? resolve(workspaceRoot) : null;
  const mcpPolicy = normalizeCursorMcpPolicy(input.cursorMcpPolicy);
  try {
    const profile = prepareCursorManagedProfile({
      workspaceRoot: resolvedWorkspaceRoot,
      mcpPolicy,
    });
    const env = buildCursorChildEnv(profile.env);
    return {
      cwd: resolvedWorkspaceRoot ?? undefined,
      env,
      cacheKey: [
        mcpPolicy,
        resolvedWorkspaceRoot ?? "",
        profile.homeDir,
        profile.configDir,
        profile.dataDir,
      ].join(":"),
      error: null,
    };
  } catch (error) {
    return {
      env: buildCursorChildEnv(),
      cacheKey: `${mcpPolicy}:${resolvedWorkspaceRoot ?? ""}`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function cloneModelResult(result: DesktopAgentProviderModelsResult): DesktopAgentProviderModelsResult {
  return modelResult(
    result.providerId,
    result.status,
    result.models,
    result.defaultModel,
    result.error,
  );
}

function normalizeOptionalPath(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

async function listOpenModelModels(
  input: DesktopAgentProviderPreflightInput,
): Promise<DesktopAgentProviderModelsResult> {
  const settings = await readOpenModelSettings();
  const selectedModel = normalizeManagedAgentModel(input.model);
  const models: DesktopAgentProviderModelOption[] = [];
  if (settings.model) {
    models.push({
      id: settings.model,
      label: `${settings.model} (saved)`,
      isDefault: true,
      source: "known",
    });
  }
  if (selectedModel && selectedModel !== settings.model) {
    models.push({
      id: selectedModel,
      label: selectedModel,
      source: normalizeManagedAgentModelSource(input.modelSource),
    });
  }
  return modelResult("open-model", "ready", models, settings.model || null, null);
}

export function parseCursorModelsOutput(output: string): DesktopAgentProviderModelOption[] {
  const models: DesktopAgentProviderModelOption[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const trimmed = rawLine.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").trim();
    if (!trimmed || /^(available\s+)?models?:?$/i.test(trimmed)) continue;
    const match = /^(?:[-*•]\s*)?(\S+)(?:\s+-\s+(.+)|\s+(\([^)]*\)))?$/.exec(trimmed);
    if (!match) continue;
    const id = match[1]?.trim();
    const label = match[2]?.trim() || (match[3] ? `${id} ${match[3].trim()}` : id);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label,
      isDefault: cursorLabelMarksDefault(label),
      source: "provider",
    });
  }
  return models;
}

export function parseCodexModelsOutput(output: string): DesktopAgentProviderModelOption[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }

  const modelEntries = codexModelEntries(parsed);
  const seen = new Set<string>();
  const models: DesktopAgentProviderModelOption[] = [];
  for (const entry of modelEntries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.hidden === true) continue;
    const visibility = typeof record.visibility === "string" ? record.visibility.toLowerCase() : null;
    if (visibility && visibility !== "list") continue;

    const id = firstStringField(record, ["slug", "id", "model"]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: firstStringField(record, ["display_name", "displayName", "name"]) || id,
      isDefault: Boolean(record.is_default || record.isDefault || record.default),
      source: "provider",
    });
  }
  return models;
}

function codexModelEntries(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.models)) return record.models;
  if (Array.isArray(record.data)) return record.data;
  return [];
}

function firstStringField(record: Record<string, unknown>, fields: string[]): string | null {
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return null;
}

function cursorDefaultModel(models: DesktopAgentProviderModelOption[]): string | null {
  return models.find((model) => model.isDefault)?.id ?? null;
}

function codexDefaultModel(models: DesktopAgentProviderModelOption[]): string | null {
  return models.find((model) => model.isDefault)?.id ?? null;
}

function cursorLabelMarksDefault(label: string): boolean {
  const metadataPattern = /\(([^)]*)\)/g;
  let group: RegExpExecArray | null;
  while ((group = metadataPattern.exec(label)) !== null) {
    const tokens = String(group[1] || "").split(",").map((token) => token.trim().toLowerCase());
    if (tokens.includes("default")) {
      return true;
    }
  }
  return false;
}

function execFileWithTimeout(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        timeout: MODEL_LIST_TIMEOUT_MS,
        maxBuffer: MODEL_LIST_MAX_BUFFER,
        cwd: options.cwd,
        env: options.env,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          error: error instanceof Error ? error.message : null,
        });
      },
    );
    child.stdin?.end();
  });
}

function firstNonEmptyLine(value: string): string | null {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

function providerLabel(providerId: DesktopAgentProviderId): string {
  if (providerId === "claude-code") return "Claude Code";
  if (providerId === "cursor") return "Cursor";
  if (providerId === "codex") return "Codex";
  if (providerId === "open-model") return "Open Model";
  return "Agent";
}

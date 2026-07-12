import { randomUUID } from "node:crypto";

import type {
  DesktopAgentProviderId,
  DesktopManagedAgentInteractionAction,
  DesktopManagedAgentInteractionField,
  DesktopManagedAgentInteractionRequest,
  DesktopManagedAgentInteractionValue,
} from "../../ipc-types.js";
import type { RpcServerRequest } from "./codex-rpc-client.js";

export const DEFAULT_MANAGED_AGENT_INTERACTION_TIMEOUT_MS = 10 * 60_000;

const SECRET_FIELD_PATTERN = /(api[_-]?key|authorization|credential|password|secret|token)/i;
const MAX_FIELDS = 12;
const MAX_OPTIONS = 20;

export interface ManagedAgentInteractionDecision {
  action: DesktopManagedAgentInteractionAction;
  answers: Record<string, DesktopManagedAgentInteractionValue>;
}

export interface NormalizedCodexInteraction {
  request: DesktopManagedAgentInteractionRequest;
  externalUrl: string | null;
  response(decision: ManagedAgentInteractionDecision): unknown;
}

export function normalizeCodexInteractionRequest(input: {
  providerId: DesktopAgentProviderId;
  sessionId: string;
  rpcRequest: RpcServerRequest;
  now?: Date;
}): NormalizedCodexInteraction {
  if (input.rpcRequest.method === "item/tool/requestUserInput") {
    return normalizeCodexUserInputRequest(input);
  }
  if (input.rpcRequest.method === "mcpServer/elicitation/request") {
    return normalizeCodexMcpElicitation(input);
  }
  throw new Error(`Unsupported Codex app-server interaction request: ${input.rpcRequest.method}`);
}

export function validateManagedAgentInteractionDecision(
  request: DesktopManagedAgentInteractionRequest,
  action: DesktopManagedAgentInteractionAction,
  rawAnswers: Record<string, DesktopManagedAgentInteractionValue> | null | undefined,
): ManagedAgentInteractionDecision {
  if (action !== "submit" && action !== "decline" && action !== "cancel") {
    throw new Error("Interaction action must be submit, decline, or cancel.");
  }
  if (action !== "submit") {
    return { action, answers: {} };
  }

  const answers = rawAnswers && typeof rawAnswers === "object" ? rawAnswers : {};
  const allowedIds = new Set(request.fields.map((field) => field.id));
  for (const id of Object.keys(answers)) {
    if (!allowedIds.has(id)) {
      throw new Error(`Unexpected interaction answer: ${id}`);
    }
  }

  const validated: Record<string, DesktopManagedAgentInteractionValue> = {};
  for (const field of request.fields) {
    const value = answers[field.id] ?? field.defaultValue;
    if (field.required && isEmptyInteractionValue(value)) {
      throw new Error(`${field.label} is required.`);
    }
    if (isEmptyInteractionValue(value)) {
      validated[field.id] = value ?? null;
      continue;
    }
    validated[field.id] = validateFieldValue(field, value);
  }
  return { action, answers: validated };
}

function normalizeCodexUserInputRequest(
  input: Parameters<typeof normalizeCodexInteractionRequest>[0],
): NormalizedCodexInteraction {
  const params = recordValue(input.rpcRequest.params);
  const questions = Array.isArray(params.questions) ? params.questions.slice(0, MAX_FIELDS) : [];
  if (!questions.length) {
    throw new Error("Codex requested user input without any questions.");
  }
  const fields = questions.map((entry, index) => normalizeCodexQuestion(entry, index));
  const now = input.now ?? new Date();
  const firstQuestion = recordValue(questions[0]);
  const timeoutMs = finitePositiveNumber(params.autoResolutionMs) ?? DEFAULT_MANAGED_AGENT_INTERACTION_TIMEOUT_MS;
  const request = baseRequest(input, {
    kind: fields.some((field) => field.type === "secret") ? "authentication" : "question",
    title: textValue(firstQuestion.header) || "Codex needs input",
    description: fields.length === 1 ? textValue(firstQuestion.question) : "Answer these questions to continue the agent turn.",
    sourceLabel: "Codex",
    fields,
    externalUrl: null,
    now,
    timeoutMs,
  });
  return {
    request,
    externalUrl: null,
    response: (decision) => ({
      answers: Object.fromEntries(fields.map((field) => [
        field.id,
        { answers: decision.action === "submit" ? answerStrings(decision.answers[field.id]) : [] },
      ])),
    }),
  };
}

function normalizeCodexMcpElicitation(
  input: Parameters<typeof normalizeCodexInteractionRequest>[0],
): NormalizedCodexInteraction {
  const params = recordValue(input.rpcRequest.params);
  const mode = textValue(params.mode);
  const now = input.now ?? new Date();
  if (mode === "openai/form") {
    throw new Error("Extended MCP App forms are unavailable in desktop-managed room sessions. Use a standard MCP form or terminal workflow.");
  }

  const externalUrl = mode === "url" ? safeHttpsUrl(params.url) : null;
  const fields = mode === "form" ? normalizeMcpFormFields(params.requestedSchema) : [];
  if (mode !== "form" && mode !== "url") {
    throw new Error(`Unsupported MCP elicitation mode: ${mode || "unknown"}`);
  }
  const sourceLabel = textValue(params.serverName) || "MCP server";
  const sensitive = fields.some((field) => field.type === "secret") || mode === "url";
  const request = baseRequest(input, {
    kind: sensitive ? "authentication" : "form",
    title: mode === "url" ? `${sourceLabel} needs authentication` : `${sourceLabel} needs input`,
    description: textValue(params.message),
    sourceLabel,
    fields,
    externalUrl,
    now,
    timeoutMs: DEFAULT_MANAGED_AGENT_INTERACTION_TIMEOUT_MS,
  });
  return {
    request,
    externalUrl,
    response: (decision) => ({
      action: decision.action === "submit" ? "accept" : decision.action,
      content: decision.action === "submit" ? decision.answers : null,
    }),
  };
}

function baseRequest(
  input: Parameters<typeof normalizeCodexInteractionRequest>[0],
  values: Pick<DesktopManagedAgentInteractionRequest, "kind" | "title" | "description" | "sourceLabel" | "fields"> & {
    externalUrl: string | null;
    now: Date;
    timeoutMs: number;
  },
): DesktopManagedAgentInteractionRequest {
  return {
    id: `interaction_${randomUUID()}`,
    providerId: input.providerId,
    sessionId: input.sessionId,
    kind: values.kind,
    title: truncate(values.title, 120),
    description: values.description ? truncate(values.description, 500) : null,
    sourceLabel: values.sourceLabel ? truncate(values.sourceLabel, 80) : null,
    fields: values.fields,
    sensitive: values.fields.some((field) => field.type === "secret") || values.kind === "authentication",
    hasExternalUrl: Boolean(values.externalUrl),
    requestedAt: values.now.toISOString(),
    expiresAt: new Date(values.now.getTime() + Math.min(values.timeoutMs, DEFAULT_MANAGED_AGENT_INTERACTION_TIMEOUT_MS)).toISOString(),
  };
}

function normalizeCodexQuestion(value: unknown, index: number): DesktopManagedAgentInteractionField {
  const question = recordValue(value);
  const id = safeFieldId(question.id, `question_${index + 1}`);
  const options = Array.isArray(question.options)
    ? question.options.slice(0, MAX_OPTIONS).map((entry) => {
      const option = recordValue(entry);
      const label = textValue(option.label) || "Option";
      return { value: label, label, description: textValue(option.description) };
    })
    : [];
  const secret = question.isSecret === true || SECRET_FIELD_PATTERN.test(id) || SECRET_FIELD_PATTERN.test(textValue(question.header) || "");
  return {
    id,
    label: truncate(textValue(question.header) || `Question ${index + 1}`, 80),
    description: textValue(question.question),
    type: secret ? "secret" : options.length ? "select" : "text",
    required: true,
    options,
    defaultValue: null,
    minimum: null,
    maximum: null,
  };
}

function normalizeMcpFormFields(value: unknown): DesktopManagedAgentInteractionField[] {
  const schema = recordValue(value);
  const properties = recordValue(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : []);
  return Object.entries(properties).slice(0, MAX_FIELDS).map(([rawId, rawField]) => {
    const field = recordValue(rawField);
    const id = safeFieldId(rawId, "field");
    const rawType = textValue(field.type) || "string";
    const enumOptions = managedElicitationOptions(field);
    const secret = SECRET_FIELD_PATTERN.test(id) || SECRET_FIELD_PATTERN.test(textValue(field.title) || "");
    const type = rawType === "boolean"
      ? "boolean"
      : rawType === "number" || rawType === "integer"
      ? "number"
      : rawType === "array" && enumOptions.length
      ? "multiselect"
      : enumOptions.length
      ? "select"
      : secret
      ? "secret"
      : "text";
    return {
      id,
      label: truncate(textValue(field.title) || rawId, 80),
      description: textValue(field.description),
      type,
      required: required.has(rawId),
      options: enumOptions,
      defaultValue: normalizeDefaultValue(type, field.default),
      minimum: numberValue(field.minimum),
      maximum: numberValue(field.maximum),
    };
  });
}

function validateFieldValue(
  field: DesktopManagedAgentInteractionField,
  value: DesktopManagedAgentInteractionValue,
): DesktopManagedAgentInteractionValue {
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${field.label} must be true or false.`);
    return value;
  }
  if (field.type === "number") {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) throw new Error(`${field.label} must be a number.`);
    if (field.minimum !== null && number < field.minimum) throw new Error(`${field.label} must be at least ${field.minimum}.`);
    if (field.maximum !== null && number > field.maximum) throw new Error(`${field.label} must be at most ${field.maximum}.`);
    return number;
  }
  if (field.type === "multiselect") {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new Error(`${field.label} must be a list of options.`);
    }
    const allowed = new Set(field.options.map((option) => option.value));
    if (value.some((entry) => !allowed.has(entry))) throw new Error(`${field.label} contains an invalid option.`);
    return value;
  }
  if (typeof value !== "string") throw new Error(`${field.label} must be text.`);
  if (field.type === "select" && !field.options.some((option) => option.value === value)) {
    throw new Error(`${field.label} contains an invalid option.`);
  }
  return value;
}

function normalizeDefaultValue(type: DesktopManagedAgentInteractionField["type"], value: unknown): DesktopManagedAgentInteractionValue {
  if (type === "boolean" && typeof value === "boolean") return value;
  if (type === "number" && typeof value === "number" && Number.isFinite(value)) return value;
  if ((type === "text" || type === "select") && typeof value === "string") return value;
  if (type === "multiselect" && Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  return null;
}

function managedElicitationOptions(field: Record<string, unknown>): DesktopManagedAgentInteractionField["options"] {
  const enumValues = Array.isArray(field.enum)
    ? field.enum.filter((entry): entry is string => typeof entry === "string").slice(0, MAX_OPTIONS)
    : [];
  const enumNames = Array.isArray(field.enumNames)
    ? field.enumNames.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (enumValues.length) {
    return enumValues.map((entry, index) => ({ value: entry, label: enumNames[index] || entry, description: null }));
  }

  const directChoices = Array.isArray(field.oneOf) ? field.oneOf : [];
  const items = recordValue(field.items);
  const itemChoices = Array.isArray(items.anyOf) ? items.anyOf : [];
  const choices = [...directChoices, ...itemChoices].slice(0, MAX_OPTIONS);
  if (choices.length) {
    return choices.flatMap((entry) => {
      const option = recordValue(entry);
      const value = textValue(option.const);
      return value ? [{ value, label: textValue(option.title) || value, description: null }] : [];
    });
  }
  const itemEnum = Array.isArray(items.enum)
    ? items.enum.filter((entry): entry is string => typeof entry === "string").slice(0, MAX_OPTIONS)
    : [];
  return itemEnum.map((entry) => ({ value: entry, label: entry, description: null }));
}

function answerStrings(value: DesktopManagedAgentInteractionValue | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [String(value)];
}

function isEmptyInteractionValue(value: DesktopManagedAgentInteractionValue | undefined): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textValue(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return text || null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finitePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function safeFieldId(value: unknown, fallback: string): string {
  const normalized = String(value ?? "").trim().replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
  return normalized || fallback;
}

function safeHttpsUrl(value: unknown): string {
  const raw = textValue(value);
  if (!raw) throw new Error("MCP authentication request did not include a URL.");
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") throw new Error("MCP authentication URLs must use HTTPS.");
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}...`;
}

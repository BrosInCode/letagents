import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCodexInteractionRequest,
  validateManagedAgentInteractionDecision,
} from "../main/agents/managed-agent-interactions.js";

test("Codex request_user_input becomes a safe managed interaction", () => {
  const normalized = normalizeCodexInteractionRequest({
    providerId: "codex",
    sessionId: "session_1",
    now: new Date("2026-07-12T00:00:00.000Z"),
    rpcRequest: {
      id: 12,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "item_1",
        questions: [{
          id: "release",
          header: "Release?",
          question: "Choose whether to release.",
          options: [
            { label: "Release", description: "Publish now." },
            { label: "Hold", description: "Keep the build private." },
          ],
        }],
      },
    },
  });

  assert.equal(normalized.request.kind, "question");
  assert.equal(normalized.request.fields[0]?.type, "select");
  assert.equal(normalized.request.fields[0]?.options.length, 2);
  const decision = validateManagedAgentInteractionDecision(normalized.request, "submit", { release: "Hold" });
  assert.deepEqual(normalized.response(decision), {
    answers: { release: { answers: ["Hold"] } },
  });
});

test("secret questions are marked sensitive and never copy answers into the request", () => {
  const normalized = normalizeCodexInteractionRequest({
    providerId: "codex",
    sessionId: "session_1",
    rpcRequest: {
      id: "request_1",
      method: "item/tool/requestUserInput",
      params: {
        questions: [{ id: "api_token", header: "API token", question: "Enter token", isSecret: true }],
      },
    },
  });

  assert.equal(normalized.request.kind, "authentication");
  assert.equal(normalized.request.sensitive, true);
  assert.equal(normalized.request.fields[0]?.type, "secret");
  assert.doesNotMatch(JSON.stringify(normalized.request), /super-secret/);
  const decision = validateManagedAgentInteractionDecision(normalized.request, "submit", { api_token: "super-secret" });
  assert.deepEqual(normalized.response(decision), {
    answers: { api_token: { answers: ["super-secret"] } },
  });
  assert.doesNotMatch(JSON.stringify(normalized.request), /super-secret/);
});

test("MCP elicitation validates primitive form fields and provider response shape", () => {
  const normalized = normalizeCodexInteractionRequest({
    providerId: "codex",
    sessionId: "session_1",
    rpcRequest: {
      id: 13,
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "deployments",
        threadId: "thread_1",
        mode: "form",
        message: "Confirm deployment settings.",
        requestedSchema: {
          type: "object",
          required: ["environment"],
          properties: {
            environment: { type: "string", enum: ["staging", "production"] },
            replicas: { type: "integer", minimum: 1, maximum: 8 },
            notify: { type: "boolean", default: true },
          },
        },
      },
    },
  });

  const decision = validateManagedAgentInteractionDecision(normalized.request, "submit", {
    environment: "staging",
    replicas: 2,
    notify: false,
  });
  assert.deepEqual(normalized.response(decision), {
    action: "accept",
    content: { environment: "staging", replicas: 2, notify: false },
  });
  assert.throws(
    () => validateManagedAgentInteractionDecision(normalized.request, "submit", { environment: "invalid" }),
    /invalid option/,
  );
});

test("MCP authentication URLs stay out of persisted interaction state", () => {
  const normalized = normalizeCodexInteractionRequest({
    providerId: "codex",
    sessionId: "session_1",
    rpcRequest: {
      id: 15,
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "deployments",
        threadId: "thread_1",
        mode: "url",
        message: "Sign in to continue.",
        elicitationId: "elicit_1",
        url: "https://auth.example.com/authorize?temporary_token=sensitive-value",
      },
    },
  });

  assert.equal(normalized.request.hasExternalUrl, true);
  assert.equal(normalized.externalUrl, "https://auth.example.com/authorize?temporary_token=sensitive-value");
  assert.doesNotMatch(JSON.stringify(normalized.request), /sensitive-value|auth\.example\.com/);
});

test("managed interactions reject extended MCP App forms instead of waiting invisibly", () => {
  assert.throws(() => normalizeCodexInteractionRequest({
    providerId: "codex",
    sessionId: "session_1",
    rpcRequest: {
      id: 14,
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "security",
        threadId: "thread_1",
        mode: "openai/form",
        message: "Configure scan",
        requestedSchema: {},
      },
    },
  }), /unavailable in desktop-managed room sessions/);
});

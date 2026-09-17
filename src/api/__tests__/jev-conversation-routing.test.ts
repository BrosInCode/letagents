import assert from "node:assert/strict";
import test from "node:test";

import {
  JEV_MAX_CANDIDATE_AGENTS,
  JEV_NEEDS_RESPONSE_MIN_PROBABILITY,
  JEV_NONE_OPTION,
  JEV_RESPONDER_MIN_PROBABILITY,
  JEV_ROUTING_DEFAULT_BASE_URL,
  JEV_ROUTING_DEFAULT_MODEL,
  JEV_ROUTING_DEFAULT_TIMEOUT_MS,
  buildJevEvaluationRequest,
  electJevResponders,
  evaluateWithJev,
  parseJevEvaluationResponse,
  readJevRoutingConfig,
  type JevRoutingConfig,
  type JevRoutingInput,
} from "../messages/jev-conversation-routing.js";

const input: JevRoutingInput = {
  agents: [
    { agent_key: "EmmyMay/cometlively", display_name: "CometLively", runtime: "claude", recent_messages: ["Reviewing PR #12 now.", "older"] },
    { agent_key: "EmmyMay/dawnridge", display_name: "DawnRidge", runtime: null, recent_messages: [] },
    { agent_key: "EmmyMay/peakcloud", display_name: "PeakCloud", runtime: "codex", recent_messages: ["Implementing the migration."] },
  ],
  recent_conversation: [
    { from: "EmmyMay", kind: "human", text: "Morning all" },
    { from: "CometLively", kind: "agent", text: "Reviewing PR #12 now." },
  ],
  latest_message: { from: "EmmyMay", kind: "human", text: "can someone look at why the migration test is red?" },
};

test("readJevRoutingConfig is off by default and requires a gateway key when enabled", () => {
  assert.deepEqual(readJevRoutingConfig({}), { status: "off" });
  assert.deepEqual(readJevRoutingConfig({ LETAGENTS_JEV_ROUTING: "nonsense", AI_GATEWAY_API_KEY: "k" }), { status: "off" });
  assert.deepEqual(readJevRoutingConfig({ LETAGENTS_JEV_ROUTING: "active" }), { status: "missing_api_key", mode: "active" });
  const enabled = readJevRoutingConfig({ LETAGENTS_JEV_ROUTING: " Shadow ", AI_GATEWAY_API_KEY: " k " });
  assert.equal(enabled.status, "enabled");
  if (enabled.status !== "enabled") return;
  assert.deepEqual(enabled.config, {
    mode: "shadow",
    provider: "gateway",
    apiKey: "k",
    baseUrl: JEV_ROUTING_DEFAULT_BASE_URL,
    model: JEV_ROUTING_DEFAULT_MODEL,
    timeoutMs: JEV_ROUTING_DEFAULT_TIMEOUT_MS,
  });
  const overridden = readJevRoutingConfig({
    LETAGENTS_JEV_ROUTING: "active",
    AI_GATEWAY_API_KEY: "k",
    AI_GATEWAY_EVALUATE_BASE_URL: "https://gateway.example/v4/ai///",
    LETAGENTS_JEV_ROUTING_TIMEOUT_MS: "800",
    LETAGENTS_JEV_ROUTING_MODEL: "typesafe-ai/jev-next",
  });
  assert.equal(overridden.status, "enabled");
  if (overridden.status !== "enabled") return;
  assert.equal(overridden.config.baseUrl, "https://gateway.example/v4/ai");
  assert.equal(overridden.config.timeoutMs, 800);
  assert.equal(overridden.config.model, "typesafe-ai/jev-next");
  const direct = readJevRoutingConfig({ LETAGENTS_JEV_ROUTING: "active", AI_GATEWAY_API_KEY: "g", TYPESAFE_API_KEY: "t" });
  assert.equal(direct.status, "enabled");
  if (direct.status !== "enabled") return;
  assert.equal(direct.config.provider, "typesafe");
  assert.equal(direct.config.apiKey, "t");
  assert.equal(direct.config.baseUrl, "https://api.typesafe.ai/v1");
  assert.equal(direct.config.model, "jev-latest");
});

test("buildJevEvaluationRequest maps agents to stable options plus none and keeps keys out of the state", () => {
  const request = buildJevEvaluationRequest(input);
  assert.deepEqual([...request.agentKeyByOption], [
    ["agent_1", "EmmyMay/cometlively"],
    ["agent_2", "EmmyMay/dawnridge"],
    ["agent_3", "EmmyMay/peakcloud"],
  ]);
  const responder = request.questions.responder as { type: string; criteria: Record<string, string> };
  assert.equal(responder.type, "choice");
  assert.deepEqual(Object.keys(responder.criteria), ["agent_1", "agent_2", "agent_3", JEV_NONE_OPTION]);
  assert.match(responder.criteria.agent_1!, /^CometLively \(claude agent\); recently said: "Reviewing PR #12 now\." \| "older"$/);
  assert.equal(responder.criteria.agent_2, "DawnRidge; has not spoken recently");
  const needs = request.questions.needs_agent_response as { type: string; criteria: { true: string; false: string } };
  assert.equal(needs.type, "boolean");
  assert.ok(needs.criteria.true && needs.criteria.false);
  // Durable agent keys are identifiers for our routing, not model input.
  assert.doesNotMatch(JSON.stringify(request.state), /EmmyMay\/(cometlively|dawnridge|peakcloud)/);
  const state = request.state as { room: { agent_count: number }; recent_conversation: unknown[]; latest_message: { text: string } };
  assert.equal(state.room.agent_count, 3);
  assert.equal(state.recent_conversation.length, 2);
  assert.equal(state.latest_message.text, input.latest_message.text);
});

test("buildJevEvaluationRequest truncates long text and caps the candidate list", () => {
  const long = "x".repeat(5_000);
  const request = buildJevEvaluationRequest({
    agents: Array.from({ length: JEV_MAX_CANDIDATE_AGENTS + 5 }, (_, index) => ({
      agent_key: `k${index}`, display_name: `A${index}`, runtime: null, recent_messages: [long],
    })),
    recent_conversation: [{ from: "h", kind: "human", text: long }],
    latest_message: { from: "h", kind: "human", text: long },
  });
  assert.equal(request.agentKeyByOption.size, JEV_MAX_CANDIDATE_AGENTS);
  const state = request.state as { agents: { recently_said: string[] }[]; recent_conversation: { text: string }[]; latest_message: { text: string } };
  assert.equal(state.agents[0]!.recently_said[0]!.length, 240);
  assert.equal(state.recent_conversation[0]!.text.length, 400);
  assert.equal(state.latest_message.text.length, 1_200);
});

test("parseJevEvaluationResponse tolerates missing and malformed fields", () => {
  assert.deepEqual(parseJevEvaluationResponse(null), { needsResponse: null, choice: null, probabilities: {}, confidence: null });
  assert.deepEqual(parseJevEvaluationResponse({ answers: { responder: { choice: 7, probabilities: { agent_1: "1" } } } }), {
    needsResponse: null, choice: null, probabilities: {}, confidence: null,
  });
  const parsed = parseJevEvaluationResponse({
    answers: {
      needs_agent_response: { type: "boolean", probability: 0.91 },
      responder: { type: "choice", choice: "agent_3", probabilities: { agent_1: 0.1, agent_2: 0.05, agent_3: 0.8, none: 0.05 } },
    },
    providerMetadata: { typesafe: { confidence: { responder: 0.77 } } },
  });
  assert.deepEqual(parsed, {
    needsResponse: 0.91,
    choice: "agent_3",
    probabilities: { agent_1: 0.1, agent_2: 0.05, agent_3: 0.8, none: 0.05 },
    confidence: 0.77,
  });
  assert.equal(parseJevEvaluationResponse({ answers: {}, providerMetadata: { typesafe: { confidence: 0.5 } } }).confidence, 0.5);
  assert.equal(parseJevEvaluationResponse({ answers: { needs_agent_response: { noul: 0.42 } } }).needsResponse, 0.42);
  assert.equal(parseJevEvaluationResponse({ answers: { responder: { choice: "agent_1", confidence: 0.93 } } }).confidence, 0.93);
});

test("electJevResponders wakes exactly one agent only when both gates pass", () => {
  const { agentKeyByOption } = buildJevEvaluationRequest(input);
  const probabilities = { agent_1: 0.1, agent_2: 0.05, agent_3: 0.8, none: 0.05 };
  const elected = electJevResponders({ needsResponse: 0.9, choice: "agent_3", probabilities, confidence: 0.7 }, agentKeyByOption);
  assert.deepEqual(elected.elected, ["EmmyMay/peakcloud"]);
  assert.equal(elected.reason, "elected");
  assert.deepEqual(elected.probabilitiesByAgentKey, {
    "EmmyMay/cometlively": 0.1, "EmmyMay/dawnridge": 0.05, "EmmyMay/peakcloud": 0.8,
  });

  const quiet = electJevResponders({ needsResponse: JEV_NEEDS_RESPONSE_MIN_PROBABILITY - 0.01, choice: "agent_3", probabilities, confidence: null }, agentKeyByOption);
  assert.deepEqual([quiet.elected, quiet.reason], [[], "no_response_needed"]);

  const none = electJevResponders({ needsResponse: 0.9, choice: JEV_NONE_OPTION, probabilities, confidence: null }, agentKeyByOption);
  assert.deepEqual([none.elected, none.reason], [[], "none_chosen"]);

  const spread = electJevResponders({
    needsResponse: 0.9, choice: "agent_3",
    probabilities: { agent_1: 0.3, agent_2: 0.3, agent_3: JEV_RESPONDER_MIN_PROBABILITY - 0.01, none: 0 },
    confidence: null,
  }, agentKeyByOption);
  assert.deepEqual([spread.elected, spread.reason], [[], "low_probability"]);

  // A choice without a probability distribution is still an answer.
  const bare = electJevResponders({ needsResponse: 0.9, choice: "agent_1", probabilities: {}, confidence: null }, agentKeyByOption);
  assert.deepEqual([bare.elected, bare.reason], [["EmmyMay/cometlively"], "elected"]);

  const unknown = electJevResponders({ needsResponse: 0.9, choice: "agent_9", probabilities, confidence: null }, agentKeyByOption);
  assert.deepEqual([unknown.elected, unknown.reason], [[], "unknown_option"]);

  const broken = electJevResponders({ needsResponse: null, choice: "agent_1", probabilities: {}, confidence: null }, agentKeyByOption);
  assert.deepEqual([broken.elected, broken.reason], [[], "unparseable"]);
});

const config: JevRoutingConfig = {
  mode: "shadow", provider: "gateway", apiKey: "test-key", baseUrl: "https://gateway.example/v4/ai", model: "typesafe-ai/jev", timeoutMs: 1_000,
};

test("evaluateWithJev speaks TypeSafe's native contract when a direct key is configured", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({
      answers: {
        needs_agent_response: { noul: 0.83 },
        responder: { choice: "agent_2", probabilities: { agent_1: 0.1, agent_2: 0.85, agent_3: 0.05, none: 0 }, confidence: 0.7 },
      },
      model: "jev-1.13.0",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const request = buildJevEvaluationRequest(input);
  const result = await evaluateWithJev(
    { ...config, provider: "typesafe", baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest" },
    request,
    { fetchImpl },
  );
  assert.equal(calls[0]!.url, "https://api.typesafe.ai/v1/systemone");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer test-key");
  assert.equal(headers["ai-model-id"], undefined);
  const body = JSON.parse(String(calls[0]!.init.body)) as { model: string; questions: Record<string, { type: string }>; providerOptions?: unknown };
  assert.equal(body.model, "jev-latest");
  assert.equal(body.questions.needs_agent_response!.type, "noul");
  assert.equal(body.questions.responder!.type, "choice");
  assert.equal(body.providerOptions, undefined);
  assert.equal(result.answers.needsResponse, 0.83);
  assert.equal(result.answers.choice, "agent_2");
  assert.equal(result.answers.confidence, 0.7);
});

test("evaluateWithJev speaks the gateway evaluation wire contract", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({
      answers: {
        needs_agent_response: { type: "boolean", probability: 0.8 },
        responder: { type: "choice", choice: "agent_1", probabilities: { agent_1: 1, none: 0 } },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const request = buildJevEvaluationRequest(input);
  const result = await evaluateWithJev(config, request, { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://gateway.example/v4/ai/evaluation-model");
  assert.equal(calls[0]!.init.method, "POST");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer test-key");
  assert.equal(headers["ai-model-id"], "typesafe-ai/jev");
  assert.equal(headers["ai-evaluation-model-specification-version"], "4");
  assert.equal(headers["ai-gateway-protocol-version"], "0.0.1");
  assert.equal(headers["ai-gateway-auth-method"], "api-key");
  assert.ok(calls[0]!.init.signal instanceof AbortSignal);
  const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["providerOptions", "questions", "state"]);
  assert.deepEqual(body.providerOptions, { gateway: { zeroDataRetention: true } });
  assert.deepEqual(body.questions, request.questions);
  assert.equal(result.answers.choice, "agent_1");
  assert.equal(result.answers.needsResponse, 0.8);
  assert.ok(result.latencyMs >= 0);
});

test("evaluateWithJev surfaces HTTP failures without leaking the credential", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response("model unavailable", { status: 503 });
  await assert.rejects(
    evaluateWithJev(config, buildJevEvaluationRequest(input), { fetchImpl }),
    (error: Error) => {
      assert.match(error.message, /HTTP 503 model unavailable/);
      assert.doesNotMatch(error.message, /test-key/);
      return true;
    },
  );
});

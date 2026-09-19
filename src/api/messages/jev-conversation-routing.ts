/**
 * Conversation routing inference for untagged room messages.
 *
 * Jev (TypeSafe AI, via Vercel AI Gateway) is an evaluation model: it scores
 * typed questions against a state we assemble and returns calibrated
 * probabilities instead of text. This module is pure — it builds the request,
 * parses the response, and turns the answers into an advisory responder
 * election. Nothing here touches the database or decides authorization; the
 * send-time routing loop re-validates every elected key against the durable
 * owned-session population before a receipt exists.
 */

export type JevRoutingMode = "shadow" | "active";
/** `gateway` = Vercel AI Gateway (AI SDK evaluation contract); `typesafe` = TypeSafe's own API. */
export type JevRoutingProvider = "gateway" | "typesafe";

export interface JevRoutingConfig {
  mode: JevRoutingMode;
  provider: JevRoutingProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export type JevRoutingConfigResolution =
  | { status: "off" }
  | { status: "missing_api_key"; mode: JevRoutingMode }
  | { status: "enabled"; config: JevRoutingConfig };

export const JEV_ROUTING_DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v4/ai";
export const JEV_ROUTING_DEFAULT_MODEL = "typesafe-ai/jev";
export const JEV_TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
export const JEV_TYPESAFE_DEFAULT_MODEL = "jev-latest";
/** Measured ~0.8s round trip for a small state from ZA; real room states are larger. */
export const JEV_ROUTING_DEFAULT_TIMEOUT_MS = 4_000;
/** The "anyone?" gate: below this, no listed agent is woken. */
export const JEV_NEEDS_RESPONSE_MIN_PROBABILITY = 0.6;
/** The chosen agent must carry at least this much of the choice mass. */
export const JEV_RESPONDER_MIN_PROBABILITY = 0.5;
/** Per-agent yes/no floor: every agent at or above it is woken. */
export const JEV_RESPOND_MIN_PROBABILITY = 0.5;
/** Choice criteria allow 255 options; keep the state small and the call fast. */
export const JEV_MAX_CANDIDATE_AGENTS = 40;

export const JEV_NONE_OPTION = "none";
const LATEST_TEXT_MAX_CHARS = 1_200;
const CONVERSATION_TEXT_MAX_CHARS = 400;
const AGENT_SNIPPET_MAX_CHARS = 240;
const AGENT_CHARTER_MAX_CHARS = 300;

export function readJevRoutingConfig(env: NodeJS.ProcessEnv = process.env): JevRoutingConfigResolution {
  const mode = (env.LETAGENTS_JEV_ROUTING ?? "off").trim().toLowerCase();
  if (mode !== "shadow" && mode !== "active") return { status: "off" };
  // A direct TypeSafe key wins over the gateway when both are present.
  const typesafeKey = env.TYPESAFE_API_KEY?.trim();
  const gatewayKey = env.AI_GATEWAY_API_KEY?.trim();
  const apiKey = typesafeKey || gatewayKey;
  if (!apiKey) return { status: "missing_api_key", mode };
  const provider: JevRoutingProvider = typesafeKey ? "typesafe" : "gateway";
  const timeout = Number.parseInt(env.LETAGENTS_JEV_ROUTING_TIMEOUT_MS ?? "", 10);
  return {
    status: "enabled",
    config: {
      mode,
      provider,
      apiKey,
      baseUrl: (provider === "typesafe"
        ? env.TYPESAFE_BASE_URL?.trim() || JEV_TYPESAFE_DEFAULT_BASE_URL
        : env.AI_GATEWAY_EVALUATE_BASE_URL?.trim() || JEV_ROUTING_DEFAULT_BASE_URL).replace(/\/+$/, ""),
      model: env.LETAGENTS_JEV_ROUTING_MODEL?.trim()
        || (provider === "typesafe" ? JEV_TYPESAFE_DEFAULT_MODEL : JEV_ROUTING_DEFAULT_MODEL),
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : JEV_ROUTING_DEFAULT_TIMEOUT_MS,
    },
  };
}

export interface JevRoutingAgentCandidate {
  agent_key: string;
  display_name: string;
  runtime: string | null;
  /** Provider model when the launcher recorded one (e.g. "sonnet"); humans refer to agents by it. */
  model: string | null;
  /** The launch charter: the only durable statement of the agent's role. */
  charter: string | null;
  /** Newest first. Role is inferred from the charter and what the agent has said, not its name. */
  recent_messages: readonly string[];
}

export interface JevRoutingConversationEntry {
  from: string;
  kind: "human" | "agent";
  text: string;
}

export interface JevRoutingInput {
  agents: readonly JevRoutingAgentCandidate[];
  /** Oldest first, excluding the latest message. */
  recent_conversation: readonly JevRoutingConversationEntry[];
  latest_message: JevRoutingConversationEntry & {
    /** Set when the human replied to a message; a reply to a human is still unaddressed to agents. */
    replying_to?: JevRoutingConversationEntry | null;
  };
}

export interface JevEvaluationRequest {
  state: unknown;
  questions: Record<string, unknown>;
  /** Choice option → durable agent_key. `none` is deliberately absent. */
  agentKeyByOption: ReadonlyMap<string, string>;
}

function truncate(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

export function buildJevEvaluationRequest(input: JevRoutingInput): JevEvaluationRequest {
  const agents = input.agents.slice(0, JEV_MAX_CANDIDATE_AGENTS);
  const agentKeyByOption = new Map<string, string>();
  const criteria: Record<string, string> = {};
  const agentState = agents.map((agent, index) => {
    const option = `agent_${index + 1}`;
    agentKeyByOption.set(option, agent.agent_key);
    const recentlySaid = agent.recent_messages
      .slice(0, 2)
      .map((text) => truncate(text, AGENT_SNIPPET_MAX_CHARS));
    const runtime = agent.runtime?.trim();
    const model = agent.model?.trim();
    const charter = agent.charter?.trim() ? truncate(agent.charter, AGENT_CHARTER_MAX_CHARS) : null;
    const identity = [runtime ? `${runtime} agent` : null, model ? `model ${model}` : null].filter(Boolean).join(", ");
    criteria[option] = `${agent.display_name}${identity ? ` (${identity})` : ""}`
      + (charter ? `; charter: ${JSON.stringify(charter)}` : "")
      + (recentlySaid.length > 0
        ? `; recently said: ${recentlySaid.map((text) => JSON.stringify(text)).join(" | ")}`
        : "; has not spoken recently");
    return {
      option,
      name: agent.display_name,
      runtime: runtime || null,
      model: model || null,
      charter,
      recently_said: recentlySaid,
    };
  });
  criteria[JEV_NONE_OPTION] = "No listed agent should respond.";
  // One independent yes/no per agent is the natural multi-select: "the cursor
  // agents" or "everyone except X" needs several agents woken, and a single
  // Choice distribution can only ever name one winner.
  const perAgentQuestions: Record<string, unknown> = Object.fromEntries(agentState.map((agent) => [
    `respond_${agent.option}`,
    {
      type: "boolean",
      instructions: `Should ${agent.name} (${agent.option}) respond to the latest message?`,
      criteria: {
        true: `The latest message is addressed to ${agent.name} — by name, by role, by runtime or`
          + ` model, or as a member of a group it belongs to (for example "the cursor agents" or`
          + ` "everyone except …") — or it concerns work that ${agent.name} is doing, or it thanks or`
          + ` acknowledges ${agent.name}'s most recent reply.`,
        false: `The latest message is meant for a different agent, for nobody in particular, or`
          + ` explicitly excludes ${agent.name}.`,
      },
    },
  ]));

  return {
    state: {
      room: {
        agent_count: agents.length,
        note: "Agents are software workers sharing a chat room with humans. Agent names are"
          + " arbitrary identifiers, not roles; infer each agent's role from its charter and what it"
          + " has said. Humans may also refer to agents by runtime (\"the cursor agents\") or by"
          + " model (\"the Sonnet model\").",
      },
      agents: agentState,
      recent_conversation: input.recent_conversation.map((entry) => ({
        from: entry.from,
        kind: entry.kind,
        text: truncate(entry.text, CONVERSATION_TEXT_MAX_CHARS),
      })),
      latest_message: {
        from: input.latest_message.from,
        kind: input.latest_message.kind,
        text: truncate(input.latest_message.text, LATEST_TEXT_MAX_CHARS),
        ...(input.latest_message.replying_to
          ? {
              replying_to: {
                from: input.latest_message.replying_to.from,
                kind: input.latest_message.replying_to.kind,
                text: truncate(input.latest_message.replying_to.text, CONVERSATION_TEXT_MAX_CHARS),
              },
            }
          : {}),
      },
    },
    questions: {
      needs_agent_response: {
        type: "boolean",
        instructions: "Does the latest message call for a reply or action from one of the listed agents?",
        criteria: {
          true: "It asks a question, makes a request, gives an instruction, or hands off work"
            + " that one of the listed agents should answer or act on; or it thanks, acknowledges,"
            + " greets, or otherwise speaks directly to an agent — a brief reply is expected then too.",
          false: "It is conversation between humans, a note about the human's own plans or"
            + " availability, a reaction, or otherwise not something any listed agent should respond to.",
        },
      },
      responder: {
        type: "choice",
        instructions: "Which agent should respond to the latest message? Prefer the agent whose"
          + " recent work or expertise the message concerns, or the agent the sender is evidently"
          + " continuing a conversation with. Choose none when no listed agent should respond.",
        criteria,
      },
      ...perAgentQuestions,
    },
    agentKeyByOption,
  };
}

export interface JevEvaluationAnswers {
  needsResponse: number | null;
  choice: string | null;
  /** Choice option → probability, as returned (may be empty). */
  probabilities: Record<string, number>;
  /** Native per-question confidence for the choice, when the provider reports one. */
  confidence: number | null;
  /** Choice option → P(this agent should respond), from the per-agent questions. */
  respondByOption: Record<string, number>;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseJevEvaluationResponse(body: unknown): JevEvaluationAnswers {
  const answers = record(record(body)?.answers);
  const needs = record(answers?.needs_agent_response);
  const responder = record(answers?.responder);
  const probabilities: Record<string, number> = {};
  for (const [option, value] of Object.entries(record(responder?.probabilities) ?? {})) {
    const probability = finiteNumber(value);
    if (probability !== null) probabilities[option] = probability;
  }
  const respondByOption: Record<string, number> = {};
  for (const [name, value] of Object.entries(answers ?? {})) {
    if (!name.startsWith("respond_")) continue;
    const answer = record(value);
    const probability = finiteNumber(answer?.probability) ?? finiteNumber(answer?.noul);
    if (probability !== null) respondByOption[name.slice("respond_".length)] = probability;
  }
  // TypeSafe's native API puts confidence on the answer; the gateway moves it
  // into provider metadata (either a number or a per-question record).
  const providerConfidence = record(record(record(body)?.providerMetadata)?.typesafe)?.confidence;
  const confidence = finiteNumber(responder?.confidence)
    ?? finiteNumber(providerConfidence)
    ?? finiteNumber(record(providerConfidence)?.responder);
  return {
    // Gateway reports a boolean as `probability`; TypeSafe's native Noul as `noul`.
    needsResponse: finiteNumber(needs?.probability) ?? finiteNumber(needs?.noul),
    choice: typeof responder?.choice === "string" ? responder.choice : null,
    probabilities,
    confidence,
    respondByOption,
  };
}

export type JevElectionReason =
  | "elected"
  | "elected_multi"
  | "no_response_needed"
  | "none_chosen"
  | "low_probability"
  | "unknown_option"
  | "unparseable";

export interface JevResponderElection {
  elected: readonly string[];
  reason: JevElectionReason;
  needsResponse: number | null;
  choice: string | null;
  probabilitiesByAgentKey: Record<string, number>;
  confidence: number | null;
  respondByAgentKey: Record<string, number>;
}

/**
 * Turns Jev's answers into advisory responders. The room-level "does anyone
 * need to respond" gate comes first. Then every agent whose own yes/no clears
 * the floor is woken — that is how "the cursor agents" wakes three. Only when
 * no agent clears it does the single-winner Choice decide, with its own floor.
 * Every failure means nobody is woken — interrupting a human conversation is
 * the costlier error, so the thresholds lean toward silence.
 */
export function electJevResponders(
  answers: JevEvaluationAnswers,
  agentKeyByOption: ReadonlyMap<string, string>,
): JevResponderElection {
  const probabilitiesByAgentKey: Record<string, number> = {};
  for (const [option, probability] of Object.entries(answers.probabilities)) {
    const agentKey = agentKeyByOption.get(option);
    if (agentKey) probabilitiesByAgentKey[agentKey] = probability;
  }
  const respondByAgentKey: Record<string, number> = {};
  for (const [option, probability] of Object.entries(answers.respondByOption)) {
    const agentKey = agentKeyByOption.get(option);
    if (agentKey) respondByAgentKey[agentKey] = probability;
  }
  const base = {
    elected: [] as readonly string[],
    needsResponse: answers.needsResponse,
    choice: answers.choice,
    probabilitiesByAgentKey,
    confidence: answers.confidence,
    respondByAgentKey,
  };
  if (answers.needsResponse === null || answers.choice === null) return { ...base, reason: "unparseable" };
  if (answers.needsResponse < JEV_NEEDS_RESPONSE_MIN_PROBABILITY) return { ...base, reason: "no_response_needed" };
  // Preserve candidate order so receipts are deterministic for equal answers.
  const multi = [...agentKeyByOption.values()]
    .filter((agentKey) => (respondByAgentKey[agentKey] ?? 0) >= JEV_RESPOND_MIN_PROBABILITY);
  if (multi.length > 0) return { ...base, elected: multi, reason: multi.length > 1 ? "elected_multi" : "elected" };
  if (answers.choice === JEV_NONE_OPTION) return { ...base, reason: "none_chosen" };
  const agentKey = agentKeyByOption.get(answers.choice);
  if (!agentKey) return { ...base, reason: "unknown_option" };
  const probability = answers.probabilities[answers.choice];
  if (probability !== undefined && probability < JEV_RESPONDER_MIN_PROBABILITY) {
    return { ...base, reason: "low_probability" };
  }
  return { ...base, elected: [agentKey], reason: "elected" };
}

export interface JevEvaluationResult {
  answers: JevEvaluationAnswers;
  latencyMs: number;
}

/** TypeSafe's native API names the boolean primitive `noul`; everything else matches. */
function toTypesafeQuestions(questions: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(questions).map(([name, question]) => {
    const spec = record(question);
    return [name, spec?.type === "boolean" ? { ...spec, type: "noul" } : question];
  }));
}

/**
 * Two wire contracts for one model. Gateway: the AI SDK's evaluation
 * contract (`POST {base}/evaluation-model`, model in a header, protocol
 * stamp required, zero data retention requested because room text is the
 * state). TypeSafe direct: `POST {base}/systemone` with the model in the body.
 */
export async function evaluateWithJev(
  config: JevRoutingConfig,
  request: Pick<JevEvaluationRequest, "state" | "questions">,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<JevEvaluationResult> {
  const startedAtMs = Date.now();
  const target: { url: string; headers: Record<string, string>; body: unknown } = config.provider === "typesafe"
    ? {
        url: `${config.baseUrl}/systemone`,
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: {
          model: config.model,
          state: request.state,
          questions: toTypesafeQuestions(request.questions),
        },
      }
    : {
        url: `${config.baseUrl}/evaluation-model`,
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          "ai-model-id": config.model,
          "ai-evaluation-model-specification-version": "4",
          // The gateway rejects evaluation calls without the SDK's protocol stamp.
          "ai-gateway-protocol-version": "0.0.1",
          "ai-gateway-auth-method": "api-key",
        },
        body: {
          state: request.state,
          questions: request.questions,
          providerOptions: { gateway: { zeroDataRetention: true } },
        },
      };
  const response = await (deps.fetchImpl ?? fetch)(target.url, {
    method: "POST",
    headers: target.headers,
    body: JSON.stringify(target.body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`Jev evaluation failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
  }
  return {
    answers: parseJevEvaluationResponse(await response.json()),
    latencyMs: Date.now() - startedAtMs,
  };
}

import { connectJsonHeaders, unary } from "./connect-rpc.mjs";
import { extractAssistantReply } from "./cascade-parsing.mjs";

/** Antigravity-Deck `src/cascade.js` — plannerConfig shape that triggers execution. */
export function deckPlannerCascadeConfig(modelId) {
  return {
    plannerConfig: {
      plannerTypeConfig: {
        case: "conversational",
        value: {},
      },
      planModel: modelId,
      requestedModel: { modelId },
    },
  };
}

/**
 * Deck uses server-streaming `SendUserCascadeMessage`: POST JSON, read full HTTP body.
 * @returns {{ status: number, text: string }}
 */
export async function sendUserCascadeMessageStream(baseUrl, csrf, body, log) {
  const url = `${baseUrl}/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: connectJsonHeaders(csrf),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  log?.(
    `SendUserCascadeMessage(stream): HTTP ${res.status} responseBytes=${text.length}`,
  );
  return { status: res.status, text };
}

export async function waitForCascadeIdle(baseUrl, csrf, cascadeId, maxMs, log) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const t = await unary(baseUrl, csrf, "GetCascadeTrajectory", { cascadeId });
    if (t.parsed?.status === "CASCADE_RUN_STATUS_IDLE") return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  log?.("waitForCascadeIdle: timeout");
  return false;
}

export async function sendAllQueuedWithRetry(baseUrl, csrf, cascadeId, modelId, log) {
  const body = {
    cascadeId,
    cascadeConfig: deckPlannerCascadeConfig(modelId),
  };
  for (let attempt = 1; attempt <= 5; attempt++) {
    const flush = await unary(baseUrl, csrf, "SendAllQueuedMessages", body);
    if (flush.status === 200) {
      log?.(`SendAllQueuedMessages: ok (attempt ${attempt})`);
      return true;
    }
    log?.("SendAllQueuedMessages:", flush.status, flush.parsed || flush.text);
    const msg = flush.parsed?.message || flush.text || "";
    const notIdle = /not idle|cascade not idle/i.test(msg);
    if (notIdle) {
      log?.(`SendAllQueuedMessages: not idle, waiting then retry (${attempt}/5)…`);
      await waitForCascadeIdle(baseUrl, csrf, cascadeId, 20_000, log);
      continue;
    }
    return false;
  }
  return false;
}

export async function pickWorkspaceModel(baseUrl, csrf, log) {
  const r = await unary(baseUrl, csrf, "GetCascadeModelConfigData", {});
  const configs = Array.isArray(r.parsed?.clientModelConfigs)
    ? r.parsed.clientModelConfigs
    : [];
  const defaultModel = r.parsed?.defaultOverrideModelConfig?.modelOrAlias?.model;
  if (typeof defaultModel === "string" && defaultModel) {
    log(`Using workspace default model=${defaultModel}`);
    return defaultModel;
  }
  const withQuota = configs.filter(
    (cfg) =>
      typeof cfg?.modelOrAlias?.model === "string" &&
      (cfg?.quotaInfo?.remainingFraction ?? 0) > 0,
  );
  const recommended = withQuota.find((cfg) => cfg?.isRecommended);
  const picked =
    recommended?.modelOrAlias?.model ||
    withQuota[0]?.modelOrAlias?.model ||
    "MODEL_PLACEHOLDER_M47";
  log(`Using workspace fallback model=${picked}`);
  return picked;
}

export function streamMethodsFromEnv() {
  const raw =
    process.env.ANTIGRAVITY_STREAM_METHODS?.trim() ||
    process.env.ANTIGRAVITY_STREAM_METHOD?.trim();
  if (raw) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [
    "StreamCascadeSummariesReactiveUpdates",
    "StreamCascadeReactiveUpdates",
    "StreamUserTrajectoryReactiveUpdates",
  ];
}

/**
 * Poll trajectory steps until assistant text, json-out, or idle/timeout.
 * @returns {{ reply: string | null, lastPayload: unknown, jsonEarly: unknown | null }}
 */
export async function cascadePollUntilReply(
  baseUrl,
  csrf,
  cascadeId,
  maxPolls,
  delayMs,
  jsonOut,
  log,
) {
  let lastPayload = null;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const trajPre = await unary(baseUrl, csrf, "GetCascadeTrajectory", {
      cascadeId,
    });
    const numTotal = trajPre.parsed?.numTotalSteps ?? 0;
    let steps = await unary(baseUrl, csrf, "GetCascadeTrajectorySteps", {
      cascadeId,
      startIndex: 0,
      endIndex: Math.max(numTotal, 1),
    });
    if (steps.status !== 200 || steps.parsed == null) {
      steps = await unary(baseUrl, csrf, "GetCascadeTrajectorySteps", {
        cascadeId,
        stepOffset: 0,
      });
    }
    const n = steps.parsed?.steps?.length ?? 0;
    const traj = trajPre;
    const status = traj.parsed?.status;
    const numTotalSteps = traj.parsed?.numTotalSteps;

    log(
      `poll ${i + 1}/${maxPolls}: steps=${n} status=${status} numTotalSteps=${numTotalSteps ?? "?"}`,
    );

    if (steps.parsed) lastPayload = steps.parsed;

    if (jsonOut && n > 0) {
      return { reply: null, lastPayload, jsonEarly: steps.parsed };
    }

    const reply = extractAssistantReply(steps.parsed);
    if (reply) {
      return { reply, lastPayload, jsonEarly: null };
    }

    if (n === 0 && status === "CASCADE_RUN_STATUS_IDLE" && i > 3) {
      log("Trajectory idle with no steps; stopping early.");
      break;
    }
  }
  return { reply: null, lastPayload, jsonEarly: null };
}

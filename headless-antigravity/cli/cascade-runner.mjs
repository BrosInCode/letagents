import crypto from "node:crypto";
import {
  extractAssistantReply,
  parseTrajectorySummaries,
  pickActiveCascadeIdFromMap,
} from "../cascade-parsing.mjs";
import { resolveCascadeAcrossLsInstances } from "../cascade-resolution.mjs";
import { unary, withOpenConnectStream } from "../connect-rpc.mjs";
import {
  cascadePollUntilReply,
  deckPlannerCascadeConfig,
  sendAllQueuedWithRetry,
  sendUserCascadeMessageStream,
  streamMethodsFromEnv,
} from "../cascade-client.mjs";
import { isTruthyEnv } from "./args.mjs";

export async function runCascadeMode({
  env,
  baseUrl,
  targetProcess,
  targetKind,
  workspaceUri,
  prompt,
  modelId,
  jsonOut,
  noStream,
  legacyReactive,
  resolveCascade,
  scanAllLs,
  verbose,
  log,
  resolveAcrossLsInstances = resolveCascadeAcrossLsInstances,
}) {
  const maxPolls = Number(env.ANTIGRAVITY_MAX_POLLS || 40);
  const delayMs = Number(env.ANTIGRAVITY_POLL_MS || 1500);
  const startBody = workspaceUri ? { workspaceUris: [workspaceUri] } : {};
  if (workspaceUri) log(`StartCascade workspaceUris=[${workspaceUri}]`);

  let currentBaseUrl = baseUrl;
  let currentTargetProcess = targetProcess;
  let currentTargetKind = targetKind;
  let reuseCascadeId = env.ANTIGRAVITY_CASCADE_ID?.trim() || null;

  if (scanAllLs) {
    if (!reuseCascadeId && !resolveCascade) {
      throw new Error(
        "--scan-all-ls / ANTIGRAVITY_SCAN_ALL_LS requires ANTIGRAVITY_CASCADE_ID and/or --resolve-cascade (or ANTIGRAVITY_RESOLVE_CASCADE=1).",
      );
    }
    const resolved = await resolveAcrossLsInstances({
      wantCascadeId: reuseCascadeId,
      workspaceUri,
      log,
    });
    if (!resolved) {
      throw new Error(
        "scan-all-ls: no language server instance reported this cascade / no active trajectory.",
      );
    }
    currentBaseUrl = resolved.baseUrl;
    currentTargetProcess = { pid: resolved.pid, csrf: resolved.csrf };
    currentTargetKind = resolved.kind;
    if (!reuseCascadeId) reuseCascadeId = resolved.cascadeId;
    log(
      `scan-all-ls: using ${currentTargetKind} pid=${resolved.pid} cascadeId=${reuseCascadeId} ${currentBaseUrl}`,
    );
  } else if (resolveCascade && !reuseCascadeId) {
    const trajectories = await unary(
      currentBaseUrl,
      currentTargetProcess.csrf,
      "GetAllCascadeTrajectories",
      {},
    );
    if (trajectories.status !== 200 || trajectories.parsed == null) {
      throw new Error(
        `GetAllCascadeTrajectories: HTTP ${trajectories.status} ${trajectories.text.slice(0, 400)}`,
      );
    }

    const summaries = parseTrajectorySummaries(trajectories.parsed);
    reuseCascadeId = pickActiveCascadeIdFromMap(summaries) || null;
    if (!reuseCascadeId) {
      throw new Error(
        "resolve-cascade: no trajectories returned (empty map). Open a chat or set ANTIGRAVITY_CASCADE_ID.",
      );
    }
    log(`resolve-cascade: picked cascadeId=${reuseCascadeId}`);
  }

  const streamFallback = isTruthyEnv(env.ANTIGRAVITY_STREAM_FALLBACK_NO_STREAM);

  async function runOneCascade(streamMethod, existingCascadeId) {
    let cascadeId;
    if (existingCascadeId) {
      cascadeId = existingCascadeId;
      log(
        `cascadeId=${cascadeId} (reuse; no StartCascade)` +
          (streamMethod ? ` reactiveStream=${streamMethod}` : " (no reactive stream)"),
      );
    } else {
      const started = await unary(
        currentBaseUrl,
        currentTargetProcess.csrf,
        "StartCascade",
        startBody,
      );
      if (!started.parsed?.cascadeId) {
        throw new Error(`StartCascade failed: ${started.status} ${started.text}`);
      }
      cascadeId = started.parsed.cascadeId;
      log(
        `cascadeId=${cascadeId}` +
          (streamMethod ? ` reactiveStream=${streamMethod}` : " (no reactive stream)"),
      );
    }

    const sendFlushAndPoll = async () => {
      const deckBody = {
        metadata: {},
        cascadeId,
        items: [{ text: prompt }],
        cascadeConfig: deckPlannerCascadeConfig(modelId),
        clientType: "CHAT_CLIENT_REQUEST_STREAM_CLIENT_TYPE_IDE",
        messageOrigin: "AGENT_MESSAGE_ORIGIN_IDE",
      };

      if (currentTargetKind === "core") {
        const skipSignal = isTruthyEnv(env.ANTIGRAVITY_SKIP_SIGNAL_EXECUTABLE);
        if (!skipSignal) {
          const signal = await unary(
            currentBaseUrl,
            currentTargetProcess.csrf,
            "SignalExecutableIdle",
            { conversationId: cascadeId },
          );
          log(
            `SignalExecutableIdle: HTTP ${signal.status} ${
              signal.parsed != null
                ? JSON.stringify(signal.parsed)
                : signal.text.slice(0, 240)
            }`,
          );
        }
      }

      const sendResult = await sendUserCascadeMessageStream(
        currentBaseUrl,
        currentTargetProcess.csrf,
        deckBody,
        log,
      );
      if (sendResult.status !== 200) {
        throw new Error(
          `SendUserCascadeMessage(stream): HTTP ${sendResult.status} ${sendResult.text.slice(0, 600)}`,
        );
      }

      const alsoFlush = isTruthyEnv(env.ANTIGRAVITY_ALSO_SEND_ALL_QUEUED);
      if (currentTargetKind === "core" && alsoFlush) {
        const flushed = await sendAllQueuedWithRetry(
          currentBaseUrl,
          currentTargetProcess.csrf,
          cascadeId,
          modelId,
          log,
        );
        if (!flushed) {
          throw new Error(
            "SendAllQueuedMessages never succeeded after retries; see stderr.",
          );
        }
      }

      return cascadePollUntilReply(
        currentBaseUrl,
        currentTargetProcess.csrf,
        cascadeId,
        maxPolls,
        delayMs,
        jsonOut,
        log,
      );
    };

    const skipLegacyStream =
      currentTargetKind !== "core" || !streamMethod || noStream || !legacyReactive;
    if (skipLegacyStream) {
      return { ...(await sendFlushAndPoll()), streamError: null };
    }

    const subscriberId = `headless-${crypto.randomUUID().slice(0, 8)}`;
    const streamRequest = { protocolVersion: 1, id: cascadeId, subscriberId };
    const streamTimeoutMs = Number(env.ANTIGRAVITY_STREAM_TIMEOUT_MS || 240_000);
    const tailMs = Number(env.ANTIGRAVITY_STREAM_TAIL_MS || 4000);

    const output = await withOpenConnectStream(
      currentBaseUrl,
      currentTargetProcess.csrf,
      streamMethod,
      streamRequest,
      sendFlushAndPoll,
      streamTimeoutMs,
      tailMs,
      log,
    );

    if (output.error) {
      return {
        reply: null,
        lastPayload: null,
        jsonEarly: null,
        streamError: output.error,
      };
    }
    if (output.status !== 200) {
      log(`Connect stream HTTP ${output.status} (${streamMethod})`);
    }
    const workResult = output.workResult;
    if (!workResult || typeof workResult !== "object") {
      return {
        reply: null,
        lastPayload: null,
        jsonEarly: null,
        streamError: "stream work returned no result",
      };
    }
    return { ...workResult, streamError: null };
  }

  function finishCascadeAttempt(pollResult) {
    if (pollResult.jsonEarly) {
      console.log(JSON.stringify(pollResult.jsonEarly, null, 2));
      return true;
    }
    if (pollResult.reply) {
      console.log(pollResult.reply);
      return true;
    }
    return false;
  }

  if (currentTargetKind === "core" && legacyReactive && !noStream) {
    for (const streamMethod of streamMethodsFromEnv()) {
      log(`--- cascade + reactive stream: ${streamMethod} ---`);
      let pollResult;
      try {
        pollResult = await runOneCascade(streamMethod, reuseCascadeId);
      } catch (error) {
        log(error instanceof Error ? error.message : String(error));
        continue;
      }
      if (pollResult.streamError) {
        log(`stream skipped: ${pollResult.streamError}`);
        continue;
      }
      if (finishCascadeAttempt(pollResult)) return;
    }
    if (streamFallback) {
      log("--- fallback: cascade without reactive stream ---");
    } else {
      console.error(
        "No assistant reply after legacy reactive stream attempts. Retry without `--legacy-stream`, " +
          "or set ANTIGRAVITY_STREAM_FALLBACK_NO_STREAM=1.",
      );
      process.exit(1);
    }
  }

  const pollResult = await runOneCascade(null, reuseCascadeId);
  if (pollResult.streamError) {
    throw new Error(pollResult.streamError);
  }
  if (finishCascadeAttempt(pollResult)) return;

  if (jsonOut && pollResult.lastPayload) {
    console.log(JSON.stringify(pollResult.lastPayload, null, 2));
    process.exit(1);
  }

  const fallback = extractAssistantReply(pollResult.lastPayload);
  if (fallback) {
    console.log(fallback);
    return;
  }

  console.error("Timeout: no assistant text found in trajectory steps.");
  if (verbose && pollResult.lastPayload) {
    console.error(JSON.stringify(pollResult.lastPayload, null, 2));
  }
  process.exit(1);
}

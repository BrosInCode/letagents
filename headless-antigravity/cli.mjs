import crypto from "node:crypto";
import { defaultWorkspaceUri, findCoreProcess, findWorkspaceProcess } from "./language-server.mjs";
import { findLsBaseUrl, unary, withOpenConnectStream } from "./connect-rpc.mjs";
import { parseTrajectorySummaries, pickActiveCascadeIdFromMap, extractAssistantReply } from "./cascade-parsing.mjs";
import { resolveCascadeAcrossLsInstances } from "./cascade-resolution.mjs";
import {
  cascadePollUntilReply,
  deckPlannerCascadeConfig,
  pickWorkspaceModel,
  sendAllQueuedWithRetry,
  sendUserCascadeMessageStream,
  streamMethodsFromEnv,
} from "./cascade-client.mjs";

function parseArgs(argv) {
  const rest = [];
  let verbose = false;
  let jsonOut = false;
  let direct = false;
  let listModels = false;
  let noStream = false;
  let legacyStream = false;
  let targetMode = null;
  let listCascades = false;
  let resolveCascade = false;
  let scanAllLs = false;
  for (const a of argv) {
    if (a === "--verbose" || a === "-v") verbose = true;
    else if (a === "--json") jsonOut = true;
    else if (a === "--direct") direct = true;
    else if (a === "--list-models") listModels = true;
    else if (a === "--list-cascades") listCascades = true;
    else if (a === "--resolve-cascade") resolveCascade = true;
    else if (a === "--scan-all-ls") scanAllLs = true;
    else if (a === "--workspace-ls") targetMode = "workspace";
    else if (a === "--core-ls") targetMode = "core";
    else if (a === "--auto-ls") targetMode = "auto";
    else if (a === "--no-stream") noStream = true;
    else if (a === "--legacy-stream") legacyStream = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        `Usage: node headless_antigravity_worker.mjs [options] [prompt...]\n` +
          `  --list-cascades  --resolve-cascade  --scan-all-ls  (see file header)`,
      );
      process.exit(0);
    } else rest.push(a);
  }
  return {
    verbose,
    jsonOut,
    direct,
    listModels,
    listCascades,
    resolveCascade,
    scanAllLs,
    noStream,
    legacyStream,
    targetMode,
    prompt: rest.join(" ").trim(),
  };
}

function normalizeTargetMode(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "workspace" || v === "core" || v === "auto") return v;
  return "auto";
}

export async function main() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED =
    process.env.NODE_TLS_REJECT_UNAUTHORIZED || "0";
  const {
    verbose,
    jsonOut,
    direct,
    listModels,
    listCascades,
    resolveCascade: resolveCascadeCli,
    scanAllLs: scanAllLsCli,
    noStream,
    legacyStream,
    targetMode: argTargetMode,
    prompt: promptArg,
  } = parseArgs(process.argv.slice(2));

  const resolveCascade =
    resolveCascadeCli ||
    process.env.ANTIGRAVITY_RESOLVE_CASCADE === "1" ||
    process.env.ANTIGRAVITY_RESOLVE_CASCADE === "true";
  const scanAllLsEnv =
    process.env.ANTIGRAVITY_SCAN_ALL_LS === "1" ||
    process.env.ANTIGRAVITY_SCAN_ALL_LS === "true";
  const scanAllLs = scanAllLsCli || scanAllLsEnv;

  const legacyReactive =
    legacyStream ||
    process.env.ANTIGRAVITY_USE_LEGACY_REACTIVE_STREAM === "1" ||
    process.env.ANTIGRAVITY_USE_LEGACY_REACTIVE_STREAM === "true";
  const prompt =
    promptArg || "What is 2+2? Only output the number.";

  const log = verbose ? (...a) => console.error(...a) : () => {};
  const workspaceUri = defaultWorkspaceUri();
  const envTargetMode = normalizeTargetMode(process.env.ANTIGRAVITY_TARGET);
  const requestedTargetMode = normalizeTargetMode(argTargetMode || envTargetMode);
  const effectiveTargetMode =
    direct && requestedTargetMode === "auto" ? "core" : requestedTargetMode;

  let targetKind = "core";
  let targetProcess = null;
  if (effectiveTargetMode !== "core" && workspaceUri) {
    const workspaceProc = findWorkspaceProcess(workspaceUri);
    if (workspaceProc?.csrf) {
      targetKind = "workspace";
      targetProcess = workspaceProc;
    } else if (effectiveTargetMode === "workspace") {
      throw new Error(
        `Workspace LS not found for ${workspaceUri}. Open the repo in Antigravity first, or rerun with --core-ls.`,
      );
    }
  }
  if (!targetProcess) {
    const core = findCoreProcess();
    if (!core?.csrf) {
      throw new Error(
        "Core LS not found. Start Antigravity and ensure a language_server_macos_arm_bin process exists without --enable_lsp.",
      );
    }
    targetProcess = core;
  }

  let baseUrl = await findLsBaseUrl(targetProcess.pid, targetProcess.csrf, log);
  log(
    `Using ${targetKind} LS pid=${targetProcess.pid} ${baseUrl}` +
      (workspaceUri ? ` workspaceUri=${workspaceUri}` : ""),
  );

  if (listCascades) {
    const r = await unary(
      baseUrl,
      targetProcess.csrf,
      "GetAllCascadeTrajectories",
      {},
    );
    if (r.status !== 200) {
      throw new Error(`GetAllCascadeTrajectories: HTTP ${r.status} ${r.text.slice(0, 400)}`);
    }
    const map = parseTrajectorySummaries(r.parsed);
    console.log(
      JSON.stringify(
        {
          raw: r.parsed,
          parsedSummaries: Object.fromEntries(map),
          pickedActive: pickActiveCascadeIdFromMap(map) || null,
        },
        null,
        2,
      ),
    );
    return;
  }

  /**
   * `--direct` keeps the core-LS shortcut default. Workspace LS chooses its live UI
   * default model when possible so we don't hard-code stale placeholders.
   */
  const modelId =
    process.env.ANTIGRAVITY_MODEL ||
    (direct
      ? "MODEL_GOOGLE_GEMINI_2_5_FLASH"
      : targetKind === "workspace"
        ? await pickWorkspaceModel(baseUrl, targetProcess.csrf, log)
        : "MODEL_CLAUDE_4_OPUS");

  if (listModels) {
    const method =
      targetKind === "workspace"
        ? "GetCascadeModelConfigData"
        : "GetCascadeModelConfigs";
    const r = await unary(baseUrl, targetProcess.csrf, method, {});
    if (r.status !== 200) {
      throw new Error(`${method}: ${r.status} ${r.text}`);
    }
    const empty =
      !r.parsed ||
      (typeof r.parsed === "object" &&
        Object.keys(/** @type {object} */ (r.parsed)).length === 0);
    if (empty) {
      console.error(
        `${method} returned an empty object (no \`clientModelConfigs\` in this session).`,
      );
      console.error(
        "For `--direct`, unset ANTIGRAVITY_MODEL to use the script default (a `MODEL_GOOGLE_GEMINI_*` enum from the LS binary), or set ANTIGRAVITY_MODEL yourself.",
      );
    }
    console.log(JSON.stringify(r.parsed, null, 2));
    return;
  }

  if (direct) {
    const r = await unary(baseUrl, targetProcess.csrf, "GetModelResponse", {
      prompt,
      model: modelId,
    });
    if (r.status !== 200 || !r.parsed?.response) {
      throw new Error(
        `GetModelResponse: ${r.status} ${r.text}\n` +
          `Hint: set ANTIGRAVITY_MODEL to a Gemini enum from \`node headless_antigravity_worker.mjs --list-models\` (UI model choice alone does not change this flag).`,
      );
    }
    if (jsonOut) {
      console.log(JSON.stringify(r.parsed, null, 2));
    } else {
      console.log(String(r.parsed.response).trim());
    }
    return;
  }

  const maxPolls = Number(process.env.ANTIGRAVITY_MAX_POLLS || 40);
  const delayMs = Number(process.env.ANTIGRAVITY_POLL_MS || 1500);
  const startBody = workspaceUri ? { workspaceUris: [workspaceUri] } : {};
  if (workspaceUri) log(`StartCascade workspaceUris=[${workspaceUri}]`);

  /** Reuse existing IDE cascade when set or resolved (skip StartCascade). */
  let reuseCascadeId = process.env.ANTIGRAVITY_CASCADE_ID?.trim() || null;

  if (scanAllLs) {
    if (!reuseCascadeId && !resolveCascade) {
      throw new Error(
        "--scan-all-ls / ANTIGRAVITY_SCAN_ALL_LS requires ANTIGRAVITY_CASCADE_ID and/or --resolve-cascade (or ANTIGRAVITY_RESOLVE_CASCADE=1).",
      );
    }
    const resolved = await resolveCascadeAcrossLsInstances({
      wantCascadeId: reuseCascadeId,
      workspaceUri,
      log,
    });
    if (!resolved) {
      throw new Error(
        "scan-all-ls: no language server instance reported this cascade / no active trajectory.",
      );
    }
    baseUrl = resolved.baseUrl;
    targetProcess = { pid: resolved.pid, csrf: resolved.csrf };
    targetKind = resolved.kind;
    if (!reuseCascadeId) reuseCascadeId = resolved.cascadeId;
    log(
      `scan-all-ls: using ${targetKind} pid=${resolved.pid} cascadeId=${reuseCascadeId} ${baseUrl}`,
    );
  } else if (resolveCascade && !reuseCascadeId) {
    const tr = await unary(
      baseUrl,
      targetProcess.csrf,
      "GetAllCascadeTrajectories",
      {},
    );
    if (tr.status !== 200 || tr.parsed == null) {
      throw new Error(
        `GetAllCascadeTrajectories: HTTP ${tr.status} ${tr.text.slice(0, 400)}`,
      );
    }
    const map = parseTrajectorySummaries(tr.parsed);
    reuseCascadeId = pickActiveCascadeIdFromMap(map) || null;
    if (!reuseCascadeId) {
      throw new Error(
        "resolve-cascade: no trajectories returned (empty map). Open a chat or set ANTIGRAVITY_CASCADE_ID.",
      );
    }
    log(`resolve-cascade: picked cascadeId=${reuseCascadeId}`);
  }

  const streamFallback =
    process.env.ANTIGRAVITY_STREAM_FALLBACK_NO_STREAM === "1" ||
    process.env.ANTIGRAVITY_STREAM_FALLBACK_NO_STREAM === "true";

  /**
   * @param {string | null} streamMethod — Connect RPC name, or null for no stream
   * @param {string | null} existingCascadeId — when set, skip StartCascade (reuse conversation)
   */
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
        baseUrl,
        targetProcess.csrf,
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
      /** @see https://github.com/tysonnbt/Antigravity-Deck/blob/main/src/cascade.js */
      const deckBody = {
        metadata: {},
        cascadeId,
        items: [{ text: prompt }],
        cascadeConfig: deckPlannerCascadeConfig(modelId),
        clientType: "CHAT_CLIENT_REQUEST_STREAM_CLIENT_TYPE_IDE",
        messageOrigin: "AGENT_MESSAGE_ORIGIN_IDE",
      };

      if (targetKind === "core") {
        const skipSig =
          process.env.ANTIGRAVITY_SKIP_SIGNAL_EXECUTABLE === "1" ||
          process.env.ANTIGRAVITY_SKIP_SIGNAL_EXECUTABLE === "true";
        if (!skipSig) {
          const sig = await unary(baseUrl, targetProcess.csrf, "SignalExecutableIdle", {
            conversationId: cascadeId,
          });
          log(
            `SignalExecutableIdle: HTTP ${sig.status} ${sig.parsed != null ? JSON.stringify(sig.parsed) : sig.text.slice(0, 240)}`,
          );
        }
      }

      const sur = await sendUserCascadeMessageStream(
        baseUrl,
        targetProcess.csrf,
        deckBody,
        log,
      );
      if (sur.status !== 200) {
        throw new Error(
          `SendUserCascadeMessage(stream): HTTP ${sur.status} ${sur.text.slice(0, 600)}`,
        );
      }

      const alsoFlush =
        process.env.ANTIGRAVITY_ALSO_SEND_ALL_QUEUED === "1" ||
        process.env.ANTIGRAVITY_ALSO_SEND_ALL_QUEUED === "true";
      if (targetKind === "core" && alsoFlush) {
        const flushed = await sendAllQueuedWithRetry(
          baseUrl,
          targetProcess.csrf,
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
        baseUrl,
        targetProcess.csrf,
        cascadeId,
        maxPolls,
        delayMs,
        jsonOut,
        log,
      );
    };

    const skipLegacyStream =
      targetKind !== "core" || !streamMethod || noStream || !legacyReactive;
    if (skipLegacyStream) {
      return { ...(await sendFlushAndPoll()), streamError: null };
    }

    const subscriberId = `headless-${crypto.randomUUID().slice(0, 8)}`;
    const streamReq = { protocolVersion: 1, id: cascadeId, subscriberId };
    const streamTimeout = Number(
      process.env.ANTIGRAVITY_STREAM_TIMEOUT_MS || 240_000,
    );
    const tailMs = Number(process.env.ANTIGRAVITY_STREAM_TAIL_MS || 4000);

    const out = await withOpenConnectStream(
      baseUrl,
      targetProcess.csrf,
      streamMethod,
      streamReq,
      sendFlushAndPoll,
      streamTimeout,
      tailMs,
      log,
    );

    if (out.error) {
      return {
        reply: null,
        lastPayload: null,
        jsonEarly: null,
        streamError: out.error,
      };
    }
    if (out.status !== 200) {
      log(`Connect stream HTTP ${out.status} (${streamMethod})`);
    }
    const wr = out.workResult;
    if (!wr || typeof wr !== "object") {
      return {
        reply: null,
        lastPayload: null,
        jsonEarly: null,
        streamError: "stream work returned no result",
      };
    }
    return { ...wr, streamError: null };
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

  if (targetKind === "core" && legacyReactive && !noStream) {
    const methods = streamMethodsFromEnv();
    for (const method of methods) {
      log(`--- cascade + reactive stream: ${method} ---`);
      let pollResult;
      try {
        pollResult = await runOneCascade(method, reuseCascadeId);
      } catch (e) {
        log(e instanceof Error ? e.message : String(e));
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

  let pollResult;
  try {
    pollResult = await runOneCascade(null, reuseCascadeId);
  } catch (e) {
    throw e;
  }
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

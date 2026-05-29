import {
  DEFAULT_PROMPT,
  USAGE,
  isTruthyEnv,
  normalizeTargetMode,
  parseArgs,
} from "./cli/args.mjs";
import {
  listCascades,
  listModels,
  resolveModelId,
  runDirectResponse,
} from "./cli/commands.mjs";
import { runCascadeMode } from "./cli/cascade-runner.mjs";
import { resolveAntigravityTarget } from "./cli/target.mjs";

export async function main(argv = process.argv.slice(2), env = process.env) {
  env.NODE_TLS_REJECT_UNAUTHORIZED = env.NODE_TLS_REJECT_UNAUTHORIZED || "0";

  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const resolveCascade =
    args.resolveCascade || isTruthyEnv(env.ANTIGRAVITY_RESOLVE_CASCADE);
  const scanAllLs = args.scanAllLs || isTruthyEnv(env.ANTIGRAVITY_SCAN_ALL_LS);
  const legacyReactive =
    args.legacyReactive ||
    isTruthyEnv(env.ANTIGRAVITY_USE_LEGACY_REACTIVE_STREAM);
  const prompt = args.prompt || DEFAULT_PROMPT;
  const log = args.verbose ? (...message) => console.error(...message) : () => {};
  const requestedTargetMode = normalizeTargetMode(
    args.targetMode || env.ANTIGRAVITY_TARGET,
  );

  const target = await resolveAntigravityTarget({
    direct: args.direct,
    requestedTargetMode,
    log,
  });

  const csrf = target.targetProcess.csrf;

  if (args.listCascades) {
    await listCascades({ baseUrl: target.baseUrl, csrf });
    return;
  }

  const modelId = await resolveModelId({
    env,
    direct: args.direct,
    targetKind: target.targetKind,
    baseUrl: target.baseUrl,
    csrf,
    log,
  });

  if (args.listModels) {
    await listModels({
      targetKind: target.targetKind,
      baseUrl: target.baseUrl,
      csrf,
    });
    return;
  }

  if (args.direct) {
    await runDirectResponse({
      baseUrl: target.baseUrl,
      csrf,
      prompt,
      modelId,
      jsonOut: args.jsonOut,
    });
    return;
  }

  await runCascadeMode({
    env,
    baseUrl: target.baseUrl,
    targetProcess: target.targetProcess,
    targetKind: target.targetKind,
    workspaceUri: target.workspaceUri,
    prompt,
    modelId,
    jsonOut: args.jsonOut,
    noStream: args.noStream,
    legacyReactive,
    resolveCascade,
    scanAllLs,
    verbose: args.verbose,
    log,
  });
}

export const DEFAULT_PROMPT = "What is 2+2? Only output the number.";

export const USAGE = `Usage: node headless_antigravity_worker.mjs [options] [prompt]

Options:
  --direct             Use AIService/GetModelResponse instead of cascade chat
  --list-models        Print available model configs as JSON
  --list-cascades      Print cascade trajectory summaries as JSON
  --resolve-cascade    Resolve ANTIGRAVITY_CASCADE_ID against active trajectories before sending
  --scan-all-ls        Scan all Antigravity LS instances for ANTIGRAVITY_CASCADE_ID before sending
  --workspace-ls       Prefer workspace language server
  --core-ls            Use core language server
  --auto-ls            Auto-select workspace LS for cascade chat and core LS for --direct
  --no-stream          Use unary ChatMessage/AddUserCascadeMessage only
  --legacy-stream      Force the old reactive stream method for cascade chat
  --json               Print raw JSON response
  -v, --verbose        Print debug logs
  -h, --help           Show this help

Environment:
  ANTIGRAVITY_MODEL=model_id
  ANTIGRAVITY_CASCADE_ID=id
  ANTIGRAVITY_TARGET=auto|core|workspace
  ANTIGRAVITY_RESOLVE_CASCADE=1
  ANTIGRAVITY_SCAN_ALL_LS=1
  ANTIGRAVITY_STREAM_FALLBACK_NO_STREAM=1
`;

export function isTruthyEnv(value) {
  return value === "1" || value === "true";
}

export function parseArgs(argv) {
  let verbose = false;
  let jsonOut = false;
  let direct = false;
  let listModels = false;
  let listCascades = false;
  let resolveCascade = false;
  let scanAllLs = false;
  let targetMode = null;
  let noStream = false;
  let legacyReactive = false;
  let help = false;
  const rest = [];

  for (const arg of argv) {
    if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (arg === "--json") jsonOut = true;
    else if (arg === "--direct") direct = true;
    else if (arg === "--list-models") listModels = true;
    else if (arg === "--list-cascades") listCascades = true;
    else if (arg === "--resolve-cascade") resolveCascade = true;
    else if (arg === "--scan-all-ls") scanAllLs = true;
    else if (arg === "--workspace-ls") targetMode = "workspace";
    else if (arg === "--core-ls") targetMode = "core";
    else if (arg === "--auto-ls") targetMode = "auto";
    else if (arg === "--no-stream") noStream = true;
    else if (arg === "--legacy-stream") legacyReactive = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else rest.push(arg);
  }

  return {
    verbose,
    jsonOut,
    direct,
    listModels,
    listCascades,
    resolveCascade,
    scanAllLs,
    targetMode,
    noStream,
    legacyReactive,
    help,
    prompt: rest.join(" ").trim(),
  };
}

export function normalizeTargetMode(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "workspace" || value === "core" || value === "auto") {
    return value;
  }
  return "auto";
}

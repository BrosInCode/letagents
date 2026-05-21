/**
 * Command Broker policy for rental workspaces.
 *
 * V1 accepts argv arrays only: no shell parsing, no network/install/publish
 * commands, and only test/check style commands are allowed.
 */

export interface CommandPolicyResult {
  allowed: boolean;
  reason?: string;
}

const SHELL_TOKENS = /[;&|`$<>]/;
const BLOCKED_WORDS = new Set([
  "add",
  "audit",
  "ci",
  "curl",
  "deploy",
  "exec-sh",
  "install",
  "login",
  "publish",
  "push",
  "release",
  "rm",
  "wget",
]);

function hasUnsafeToken(argv: string[]): boolean {
  return argv.some((part) => (
    part.includes("\0") ||
    SHELL_TOKENS.test(part)
  ));
}

function hasBlockedWord(argv: string[]): boolean {
  return argv.some((part) => BLOCKED_WORDS.has(part.toLowerCase()));
}

function looksLikeTestScript(script: string | undefined): boolean {
  if (!script) return false;
  return /^(test|check|typecheck|lint|verify)([:\w.-]*)?$/i.test(script);
}

function isAllowedNpm(argv: string[]): boolean {
  const subcommand = argv[1]?.toLowerCase();
  if (subcommand === "test") return true;
  if (subcommand === "run") return looksLikeTestScript(argv[2]);
  if (subcommand === "exec") {
    const tool = argv[2]?.toLowerCase();
    if (tool === "tsc") return true;
    if (tool === "tsx") return argv.includes("--test");
    return tool === "vitest" || tool === "jest";
  }
  return false;
}

function isAllowedNode(argv: string[]): boolean {
  if (!argv.includes("--test")) return false;
  return argv.slice(1).some((part) => (
    part.includes("__tests__") ||
    /\.test\.[cm]?[jt]s$/.test(part) ||
    part === "--test"
  ));
}

function isAllowedPackageRunner(argv: string[]): boolean {
  const command = argv[0]?.toLowerCase();
  if (command === "pnpm") {
    const subcommand = argv[1]?.toLowerCase();
    if (subcommand === "test") return true;
    if (subcommand === "run") return looksLikeTestScript(argv[2]);
    if (subcommand === "exec") return ["tsc", "vitest", "jest"].includes(argv[2]?.toLowerCase() ?? "");
  }
  if (command === "yarn") {
    const subcommand = argv[1]?.toLowerCase();
    return subcommand === "test" || looksLikeTestScript(subcommand);
  }
  return false;
}

export function evaluateCommandPolicy(argv: string[]): CommandPolicyResult {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { allowed: false, reason: "argv must contain at least one command" };
  }
  if (argv.some((part) => typeof part !== "string" || !part.trim())) {
    return { allowed: false, reason: "argv entries must be non-empty strings" };
  }
  if (hasUnsafeToken(argv)) {
    return { allowed: false, reason: "shell metacharacters are not allowed" };
  }
  if (hasBlockedWord(argv)) {
    return { allowed: false, reason: "install/network/publish commands are not allowed" };
  }

  const command = argv[0]!.toLowerCase();
  if (command === "npm") {
    return isAllowedNpm(argv)
      ? { allowed: true }
      : { allowed: false, reason: "npm command must be test/check/typecheck style" };
  }
  if (command === "node") {
    return isAllowedNode(argv)
      ? { allowed: true }
      : { allowed: false, reason: "node commands must use --test" };
  }
  if (command === "pnpm" || command === "yarn") {
    return isAllowedPackageRunner(argv)
      ? { allowed: true }
      : { allowed: false, reason: "package runner command must be test/check/typecheck style" };
  }

  return { allowed: false, reason: `command not allowed: ${argv[0]}` };
}

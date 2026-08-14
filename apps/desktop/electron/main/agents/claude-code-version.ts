export const MINIMUM_SUPERVISED_CLAUDE_CODE_VERSION = "2.1.70";

/** One executable authority shared by desktop setup checks and daemon launch. */
export function resolveClaudeCodeExecutable(
  env: Readonly<NodeJS.ProcessEnv>,
  fallback = "claude",
): string {
  return env.LETAGENTS_CLAUDE_CODE_BIN?.trim()
    || env.LETAGENTS_CLAUDE_BIN?.trim()
    || fallback;
}

export type ClaudeCodeVersionReadiness = {
  version: string | null;
  supported: boolean;
  error: string | null;
};

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  version: string;
};

function parseVersion(value: string): ParsedVersion | null {
  const match = value.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, version: `${major}.${minor}.${patch}` };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function inspectClaudeCodeVersion(output: string): ClaudeCodeVersionReadiness {
  const parsed = parseVersion(output.trim());
  const minimum = parseVersion(MINIMUM_SUPERVISED_CLAUDE_CODE_VERSION)!;
  if (!parsed) {
    return {
      version: null,
      supported: false,
      error: "Claude Code returned an unreadable version. Update Claude Code with 'claude update', then try again.",
    };
  }
  if (compareVersions(parsed, minimum) < 0) {
    return {
      version: parsed.version,
      supported: false,
      error: `Claude Code ${parsed.version} is too old for supervised room agents. Update to ${MINIMUM_SUPERVISED_CLAUDE_CODE_VERSION} or newer with 'claude update', then try again.`,
    };
  }
  return { version: parsed.version, supported: true, error: null };
}

export function requireSupportedClaudeCodeVersion(output: string): string {
  const readiness = inspectClaudeCodeVersion(output);
  if (!readiness.supported || !readiness.version) {
    throw new Error(readiness.error ?? "Claude Code is not supported.");
  }
  return readiness.version;
}

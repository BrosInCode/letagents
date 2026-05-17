/**
 * Secret Firewall Service — p4.2
 *
 * Per spec §12, prevents secrets and sensitive config from reaching
 * the provider workspace. Uses layered detection:
 *
 * 1. Filename/path denylist (blocked entirely)
 * 2. Known secret regex patterns (redacted)
 * 3. Shannon entropy detector (flagged for review)
 *
 * V1 is strict: false positives are safer than leaking keys.
 *
 * Returns structured results:
 * - "passed": content is safe to expose
 * - "redacted": content was modified (secrets replaced with placeholders)
 * - "blocked": entire file is blocked from exposure
 */

import * as path from "path";
import {
  BLOCKED_FILENAMES,
  BLOCKED_EXTENSIONS,
  SECRET_PATTERNS,
  ENTROPY_THRESHOLD,
  ENTROPY_MIN_LENGTH,
  ENTROPY_MAX_LENGTH,
} from "./secret-firewall-patterns.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FirewallVerdict = "passed" | "redacted" | "blocked";

export interface FirewallFinding {
  /** Name/category of the finding. */
  name: string;
  /** Line number where the finding was detected (1-indexed). */
  line?: number;
  /** What was redacted or blocked. */
  detail: string;
}

export interface FirewallScanResult {
  /** The verdict: passed, redacted, or blocked. */
  verdict: FirewallVerdict;
  /** The (possibly redacted) content. null if blocked. */
  content: string | null;
  /** List of findings. */
  findings: FirewallFinding[];
  /** Number of redactions applied. */
  redactionCount: number;
  /** Original path scanned. */
  filePath: string;
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Scan a file path + content through the Secret Firewall.
 *
 * @param filePath - Relative path within the workspace
 * @param content  - File content as string
 * @returns Structured scan result with verdict, redacted content, and findings
 */
export function scanFile(filePath: string, content: string): FirewallScanResult {
  const findings: FirewallFinding[] = [];

  // Layer 1: Filename/path denylist — entire file is blocked
  const pathVerdict = checkPathDenylist(filePath);
  if (pathVerdict) {
    return {
      verdict: "blocked",
      content: null,
      findings: [pathVerdict],
      redactionCount: 0,
      filePath,
    };
  }

  // Layer 2: Extension denylist — entire file is blocked
  const extVerdict = checkExtensionDenylist(filePath);
  if (extVerdict) {
    return {
      verdict: "blocked",
      content: null,
      findings: [extVerdict],
      redactionCount: 0,
      filePath,
    };
  }

  // Layer 3: Known secret regex patterns — redact in-place
  let redactedContent = content;
  let redactionCount = 0;

  for (const pattern of SECRET_PATTERNS) {
    // Clone the regex to reset lastIndex
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(redactedContent)) !== null) {
      const matchedText = match[0];
      findings.push({
        name: pattern.name,
        line: getLineNumber(redactedContent, match.index),
        detail: `${maskSecret(matchedText)} → ${pattern.placeholder}`,
      });

      redactedContent =
        redactedContent.slice(0, match.index) +
        pattern.placeholder +
        redactedContent.slice(match.index + matchedText.length);

      redactionCount++;

      // Reset regex after mutation to avoid infinite loops
      regex.lastIndex = match.index + pattern.placeholder.length;
    }
  }

  // Layer 4: Entropy-based detection — redact high-entropy strings
  const entropyResult = scanAndRedactEntropy(redactedContent);
  if (entropyResult.findings.length > 0) {
    findings.push(...entropyResult.findings);
    redactedContent = entropyResult.content;
    redactionCount += entropyResult.redactionCount;
  }

  const verdict: FirewallVerdict =
    redactionCount > 0 ? "redacted" : "passed";

  return {
    verdict,
    content: redactedContent,
    findings,
    redactionCount,
    filePath,
  };
}

/**
 * Quick check if a file path is blocked by the denylist.
 * Does not scan content — just checks the path.
 */
export function isPathBlocked(filePath: string): boolean {
  return (
    checkPathDenylist(filePath) !== null ||
    checkExtensionDenylist(filePath) !== null
  );
}

/**
 * Scan only content (no path check) for secrets.
 * Used for command output, search results, etc. that don't have paths.
 */
export function scanContent(content: string): FirewallScanResult {
  return scanFile("", content);
}

// ---------------------------------------------------------------------------
// Layer 1: Path denylist
// ---------------------------------------------------------------------------

function checkPathDenylist(filePath: string): FirewallFinding | null {
  const basename = path.basename(filePath);
  const normalized = filePath.replace(/\\/g, "/");

  // Catch-all: any .env.* file is blocked
  if (/^\.env(\..+)?$/.test(basename)) {
    return {
      name: "Path denylist",
      detail: `Environment variables file: ${basename}`,
    };
  }

  // Nested credential directories — always blocked
  const nestedCredDirs = [
    { dir: ".ssh", reason: "SSH directory" },
    { dir: ".aws", reason: "AWS credentials directory" },
    { dir: ".gnupg", reason: "GnuPG directory" },
    { dir: ".config/gcloud", reason: "Google Cloud credentials" },
  ];
  for (const { dir, reason } of nestedCredDirs) {
    if (normalized.includes(`/${dir}/`) || normalized.startsWith(`${dir}/`)) {
      return {
        name: "Path denylist",
        detail: `${reason}: ${dir}/`,
      };
    }
  }

  for (const entry of BLOCKED_FILENAMES) {
    // Check exact filename match
    if (basename === entry.pattern || normalized === entry.pattern) {
      return {
        name: "Path denylist",
        detail: `${entry.reason}: ${entry.pattern}`,
      };
    }

    // Check if the pattern is a path component
    if (entry.pattern.includes("/")) {
      if (normalized.endsWith(entry.pattern) || normalized.includes(entry.pattern)) {
        return {
          name: "Path denylist",
          detail: `${entry.reason}: ${entry.pattern}`,
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Layer 2: Extension denylist
// ---------------------------------------------------------------------------

function checkExtensionDenylist(filePath: string): FirewallFinding | null {
  const ext = path.extname(filePath).toLowerCase();

  for (const entry of BLOCKED_EXTENSIONS) {
    if (ext === entry.ext) {
      return {
        name: "Extension denylist",
        detail: `${entry.reason}: ${entry.ext}`,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Layer 4: Entropy detection
// ---------------------------------------------------------------------------

/**
 * Scan content for high-entropy strings and redact them.
 * V1 policy: strict — unknown high-entropy strings are redacted.
 */
function scanAndRedactEntropy(content: string): {
  content: string;
  findings: FirewallFinding[];
  redactionCount: number;
} {
  const findings: FirewallFinding[] = [];
  const lines = content.split("\n");
  let redactionCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Look for quoted strings
    const quotedStrings = [...line.matchAll(/["']([^"']{16,500})["']/g)];

    // Process in reverse order to avoid index shifts
    for (let j = quotedStrings.length - 1; j >= 0; j--) {
      const match = quotedStrings[j];
      const value = match[1];
      if (
        value.length >= ENTROPY_MIN_LENGTH &&
        value.length <= ENTROPY_MAX_LENGTH
      ) {
        const entropy = shannonEntropy(value);
        if (entropy >= ENTROPY_THRESHOLD) {
          // Check it's not already redacted
          if (!value.startsWith("REDACTED")) {
            findings.push({
              name: "High entropy string",
              line: i + 1,
              detail: `Entropy ${entropy.toFixed(2)} ≥ ${ENTROPY_THRESHOLD}: ${maskSecret(value)}`,
            });

            // Redact: replace the value inside the quotes
            const matchStart = match.index!;
            const quoteChar = line[matchStart];
            lines[i] =
              line.slice(0, matchStart) +
              quoteChar +
              "REDACTED_HIGH_ENTROPY" +
              quoteChar +
              line.slice(matchStart + match[0].length);
            redactionCount++;
          }
        }
      }
    }
  }

  return {
    content: lines.join("\n"),
    findings,
    redactionCount,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Calculate Shannon entropy of a string.
 */
function shannonEntropy(str: string): number {
  const freq = new Map<string, number>();
  for (const ch of str) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }

  let entropy = 0;
  const len = str.length;
  for (const count of freq.values()) {
    const p = count / len;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  return entropy;
}

/**
 * Mask a secret for safe logging: show first 4 and last 2 chars.
 */
function maskSecret(secret: string): string {
  if (secret.length <= 10) {
    return "***";
  }
  return `${secret.slice(0, 4)}...${secret.slice(-2)}`;
}

/**
 * Get 1-indexed line number from a character offset.
 */
function getLineNumber(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

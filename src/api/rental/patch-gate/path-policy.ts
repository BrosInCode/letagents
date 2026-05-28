/** Paths that should always trigger renter approval. */
const SENSITIVE_PATH_PATTERNS = [
  /^\.github\//,
  /^\.gitlab-ci/,
  /Dockerfile$/i,
  /^docker-compose/i,
  /^Makefile$/i,
  /^\.env/,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
  /^tsconfig.*\.json$/,
  /^\.eslintrc/,
  /^\.prettierrc/,
];

/**
 * Validate a file path is safe for patch operations.
 * Rejects absolute paths, traversal, and null bytes.
 */
export function validatePatchPath(filePath: string): {
  valid: boolean;
  reason?: string;
  sensitive: boolean;
} {
  const normalized = filePath.replace(/\\/g, "/");

  if (normalized.includes("\0")) {
    return { valid: false, reason: "Null byte in path", sensitive: false };
  }

  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return {
      valid: false,
      reason: `Absolute path rejected: "${filePath}"`,
      sensitive: false,
    };
  }

  const segments = normalized.split("/");
  let depth = 0;
  for (const segment of segments) {
    if (segment === "..") {
      depth--;
      if (depth < 0) {
        return {
          valid: false,
          reason: `Path traversal detected: "${filePath}"`,
          sensitive: false,
        };
      }
    } else if (segment !== "." && segment !== "") {
      depth++;
    }
  }

  return {
    valid: true,
    sensitive: SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized)),
  };
}

/**
 * Normalize a file path for consistent comparison.
 */
export function normalizePatchPath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

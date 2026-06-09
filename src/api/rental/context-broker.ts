/**
 * Context Broker — p4.4
 *
 * Serves scoped workspace context to rented provider agents through
 * explicit tool calls. Every served file or search snippet goes through
 * the Secret Firewall and is appended to the Exposure Ledger.
 */

import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import { and, eq } from "drizzle-orm";

import { rental_workspace_manifests } from "../db/schema.js";
import {
  recordExposure,
  type RecordExposureInput,
  type SecretScanStatus,
} from "./exposure-ledger.js";
import {
  scanFile,
  type FirewallFinding,
} from "./secret-firewall.js";

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_SEARCH_RESULTS = 20;
const DEFAULT_MAX_SEARCH_FILE_BYTES = 128 * 1024;
const MAX_SEARCH_RESULTS_CAP = 100;
const MAX_SEARCH_FILES_SCANNED = 5_000;
const MAX_SEARCH_TOTAL_FILE_BYTES = 50 * 1024 * 1024;
const MAX_SEARCH_DIRECTORY_DEPTH = 24;

export interface ContextWorkspaceManifest {
  id: string;
  session_id: string;
  workspace_path: string | null;
  retention_status: string;
}

export interface ContextBrokerDeps {
  getActiveManifest(sessionId: string): Promise<ContextWorkspaceManifest | null>;
  recordExposure(input: RecordExposureInput): Promise<unknown>;
}

export interface ContextReadFileInput {
  sessionId: string;
  path: string;
  maxBytes?: number;
  requestedBy?: string;
}

export interface ContextReadFileResult {
  success: boolean;
  path?: string;
  content?: string;
  secretScanStatus?: SecretScanStatus;
  redactionCount?: number;
  findings?: FirewallFinding[];
  bytes?: number;
  manifestId?: string;
  error?: string;
}

export interface ContextSearchInput {
  sessionId: string;
  query: string;
  maxResults?: number;
  caseSensitive?: boolean;
  requestedBy?: string;
}

export interface ContextSearchResultItem {
  path: string;
  line: number;
  preview: string;
  secretScanStatus: SecretScanStatus;
  redactionCount: number;
}

export interface ContextSearchResult {
  success: boolean;
  query?: string;
  results?: ContextSearchResultItem[];
  count?: number;
  truncated?: boolean;
  manifestId?: string;
  error?: string;
}

export function createDefaultContextBrokerDeps(): ContextBrokerDeps {
  return {
    async getActiveManifest(sessionId) {
      const { db } = await import("../db/client.js");
      const [row] = await db
        .select()
        .from(rental_workspace_manifests)
        .where(
          and(
            eq(rental_workspace_manifests.session_id, sessionId),
            eq(rental_workspace_manifests.retention_status, "active"),
          ),
        );
      return (row as ContextWorkspaceManifest | undefined) ?? null;
    },
    async recordExposure(input) {
      const { db } = await import("../db/client.js");
      return recordExposure(
        {
          db: db as any,
          generateId: () => `rexpo_${randomUUID().replace(/-/g, "")}`,
        },
        input,
      );
    },
  };
}

export async function readContextFile(
  deps: ContextBrokerDeps,
  input: ContextReadFileInput,
): Promise<ContextReadFileResult> {
  const manifest = await deps.getActiveManifest(input.sessionId);
  const ready = await resolveWorkspace(manifest);
  if ("error" in ready) return { success: false, error: ready.error };

  const normalized = normalizeRepoPath(input.path);
  if ("error" in normalized) return { success: false, error: normalized.error };

  const maxBytes = normalizePositiveInt(input.maxBytes, DEFAULT_MAX_FILE_BYTES);
  const target = await resolveWorkspaceFile(ready.workspaceRoot, normalized.path);
  if ("error" in target) return { success: false, path: normalized.path, error: target.error };

  const pathOnlyScan = scanFile(normalized.path, "");
  if (pathOnlyScan.verdict === "blocked") {
    await deps.recordExposure({
      sessionId: input.sessionId,
      path: normalized.path,
      exposureType: "file",
      reason: "rental_read_file",
      redactionCount: 0,
      secretScanStatus: "blocked",
      requestedBy: input.requestedBy,
      scopeId: ready.manifest.id,
    });
    return {
      success: false,
      path: normalized.path,
      secretScanStatus: "blocked",
      redactionCount: 0,
      findings: pathOnlyScan.findings,
      manifestId: ready.manifest.id,
      error: "secret_blocked",
    };
  }

  if (target.size > maxBytes) {
    return {
      success: false,
      path: normalized.path,
      error: `file_too_large:${target.size}:max_${maxBytes}`,
    };
  }

  const content = await fs.readFile(target.absolutePath, "utf8");
  const scan = scanFile(normalized.path, content);
  const secretScanStatus = scan.verdict;

  await deps.recordExposure({
    sessionId: input.sessionId,
    path: normalized.path,
    exposureType: "file",
    content: scan.content ?? undefined,
    reason: "rental_read_file",
    redactionCount: scan.redactionCount,
    secretScanStatus,
    requestedBy: input.requestedBy,
    scopeId: ready.manifest.id,
  });

  if (scan.verdict === "blocked") {
    return {
      success: false,
      path: normalized.path,
      secretScanStatus,
      redactionCount: scan.redactionCount,
      findings: scan.findings,
      manifestId: ready.manifest.id,
      error: "secret_blocked",
    };
  }

  return {
    success: true,
    path: normalized.path,
    content: scan.content ?? "",
    bytes: Buffer.byteLength(scan.content ?? "", "utf8"),
    secretScanStatus,
    redactionCount: scan.redactionCount,
    findings: scan.findings,
    manifestId: ready.manifest.id,
  };
}

export async function searchContext(
  deps: ContextBrokerDeps,
  input: ContextSearchInput,
): Promise<ContextSearchResult> {
  const query = input.query.trim();
  if (!query) return { success: false, error: "query is required" };

  const manifest = await deps.getActiveManifest(input.sessionId);
  const ready = await resolveWorkspace(manifest);
  if ("error" in ready) return { success: false, error: ready.error };

  const maxResults = Math.min(
    normalizePositiveInt(input.maxResults, DEFAULT_MAX_SEARCH_RESULTS),
    MAX_SEARCH_RESULTS_CAP,
  );
  const needle = input.caseSensitive ? query : query.toLowerCase();
  const files = await listWorkspaceFiles(ready.workspaceRoot);
  const results: ContextSearchResultItem[] = [];
  const exposuresByPath = new Map<string, { content: string[]; redactions: number; status: SecretScanStatus }>();
  let totalBytesScanned = 0;

  for (const filePath of files) {
    if (results.length >= maxResults) break;
    const stat = await fs.stat(filePath);
    if (stat.size > DEFAULT_MAX_SEARCH_FILE_BYTES) continue;
    if (totalBytesScanned + stat.size > MAX_SEARCH_TOTAL_FILE_BYTES) break;
    totalBytesScanned += stat.size;

    const relPath = toRepoPath(path.relative(ready.workspaceRoot, filePath));
    if (scanFile(relPath, "").verdict === "blocked") continue;

    const raw = await fs.readFile(filePath, "utf8");
    if (raw.includes("\0")) continue;

    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= maxResults) break;
      const haystack = input.caseSensitive ? lines[i] : lines[i]!.toLowerCase();
      if (!haystack.includes(needle)) continue;

      const scan = scanFile(relPath, lines[i]!);
      const status = scan.verdict === "blocked" ? "blocked" : scan.verdict;
      const preview = scan.content ?? "";
      results.push({
        path: relPath,
        line: i + 1,
        preview,
        secretScanStatus: status,
        redactionCount: scan.redactionCount,
      });

      const existing = exposuresByPath.get(relPath) ?? {
        content: [],
        redactions: 0,
        status: "passed" as SecretScanStatus,
      };
      existing.content.push(`${i + 1}: ${preview}`);
      existing.redactions += scan.redactionCount;
      if (status === "blocked") existing.status = "blocked";
      else if (status === "redacted" && existing.status !== "blocked") existing.status = "redacted";
      exposuresByPath.set(relPath, existing);
    }
  }

  for (const [relPath, exposure] of exposuresByPath) {
    await deps.recordExposure({
      sessionId: input.sessionId,
      path: relPath,
      exposureType: "search_result",
      content: exposure.content.join("\n"),
      reason: `rental_search:${query.slice(0, 80)}`,
      redactionCount: exposure.redactions,
      secretScanStatus: exposure.status,
      requestedBy: input.requestedBy,
      scopeId: ready.manifest.id,
    });
  }

  return {
    success: true,
    query,
    results,
    count: results.length,
    truncated: results.length >= maxResults,
    manifestId: ready.manifest.id,
  };
}

async function resolveWorkspace(
  manifest: ContextWorkspaceManifest | null,
): Promise<
  | { manifest: ContextWorkspaceManifest; workspaceRoot: string }
  | { error: string }
> {
  if (!manifest || manifest.retention_status !== "active") {
    return { error: "workspace_not_ready" };
  }
  if (!manifest.workspace_path) {
    return { error: "workspace_path_missing" };
  }
  try {
    const workspaceRoot = await fs.realpath(manifest.workspace_path);
    const stat = await fs.stat(workspaceRoot);
    if (!stat.isDirectory()) return { error: "workspace_path_not_directory" };
    return { manifest, workspaceRoot };
  } catch {
    return { error: "workspace_path_missing" };
  }
}

function normalizeRepoPath(filePath: string): { path: string } | { error: string } {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return { error: "path is required" };
  }
  if (filePath.includes("\0")) return { error: "path contains null byte" };

  const normalized = toRepoPath(filePath.trim());
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return { error: "absolute_path_rejected" };
  }

  const segments = normalized.split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) return { error: "path_traversal_rejected" };
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  const result = resolved.join("/");
  if (!result) return { error: "path is required" };
  return { path: result };
}

async function resolveWorkspaceFile(
  workspaceRoot: string,
  relPath: string,
): Promise<{ absolutePath: string; size: number } | { error: string }> {
  const absolutePath = path.resolve(workspaceRoot, relPath);
  if (!isWithinRoot(workspaceRoot, absolutePath)) {
    return { error: "path_traversal_rejected" };
  }

  let lstat;
  try {
    lstat = await fs.lstat(absolutePath);
  } catch {
    return { error: "file_not_found" };
  }
  if (lstat.isSymbolicLink()) return { error: "symlink_rejected" };
  if (!lstat.isFile()) return { error: "not_a_file" };

  const realPath = await fs.realpath(absolutePath);
  if (!isWithinRoot(workspaceRoot, realPath)) {
    return { error: "path_traversal_rejected" };
  }

  return { absolutePath: realPath, size: lstat.size };
}

async function listWorkspaceFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (files.length >= MAX_SEARCH_FILES_SCANNED || depth > MAX_SEARCH_DIRECTORY_DEPTH) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_SEARCH_FILES_SCANNED) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  await walk(root, 0);
  return files;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function toRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

/** Small path, identity, limit, error, byte and file-system helpers shared by the generation steps. */
import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_LIMITS, type GenerationManifest, MANIFEST_NAME, SupervisedWorkspaceGenerationError, type SupervisedWorkspaceGenerationFailpoint, type SupervisedWorkspaceGenerationFailpointHandler, type SupervisedWorkspaceGenerationLimits, type SupervisedWorkspaceGenerationResult, type TreeEntry } from "./types.js";

export function fileVersionKey(info: BigIntStats): string {
  return [
    info.dev, info.ino, info.birthtimeNs, info.ctimeNs, info.mtimeNs,
    info.size, info.mode, info.uid, info.gid, info.nlink,
  ].join(":");
}

export function projectRelativePath(sourcePath: string, prefix: string): string | null {
  if (prefix === "") return sourcePath;
  if (sourcePath === prefix) return "";
  return sourcePath.startsWith(`${prefix}${sep}`) ? sourcePath.slice(prefix.length + 1) : null;
}

export function isProtectedPath(relativePath: string): boolean {
  const protectedComponents = new Set([".git", ".cursor", ".claude", ".letagents-fence"]);
  return relativePath.split(sep).some((component) =>
    protectedComponents.has(component.normalize("NFC").toLowerCase()),
  );
}

export function generationIdFor(sourceRoot: string, turnIdentity: string): string {
  return createHash("sha256").update(sourceRoot).update("\0").update(turnIdentity).digest("hex").slice(0, 32);
}

export function generationDirectoryName(sourceRoot: string, generationId: string): string {
  return `.${basename(sourceRoot)}.letagents-generation-${generationId}`;
}

export function manifestPathOf(manifest: GenerationManifest): string {
  return join(manifest.generationRoot, MANIFEST_NAME);
}

export function resultFor(manifest: GenerationManifest): SupervisedWorkspaceGenerationResult {
  return {
    phase: manifest.phase,
    appliedPaths: manifest.operationJournal.filter((entry) => entry.status === "applied").map((entry) => entry.relativePath),
    manifestPath: manifestPathOf(manifest),
  };
}

export function treeEntryEqual(a: TreeEntry | null | undefined, b: TreeEntry | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.mode === b.mode && a.oid === b.oid;
}

export function operationId(sourceRelativePath: string, before: TreeEntry | null, after: TreeEntry | null): string {
  return createHash("sha256")
    .update(sourceRelativePath).update("\0")
    .update(before?.mode ?? "missing").update("\0").update(before?.oid ?? "missing").update("\0")
    .update(after?.mode ?? "missing").update("\0").update(after?.oid ?? "missing")
    .digest("hex").slice(0, 24);
}

export function safeRelative(parent: string, child: string): string {
  const result = relative(resolve(parent), resolve(child));
  if (result === "") return "";
  if (result === ".." || result.startsWith(`..${sep}`) || isAbsolute(result)) throw generationError("Path escapes its supervised root.", "PATH_ESCAPE");
  return result;
}

export function assertSafeRelativePath(relativePath: string, limits: SupervisedWorkspaceGenerationLimits): void {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(sep).includes("..") || relativePath.includes("\0")) {
    throw generationError("Unsafe relative path.", "PATH_ESCAPE");
  }
  if (Buffer.byteLength(relativePath) > limits.maxRelativePathBytes) throw limitError("relative path bytes", limits.maxRelativePathBytes);
}

export function normalizeLimits(input: Partial<SupervisedWorkspaceGenerationLimits> | undefined): SupervisedWorkspaceGenerationLimits {
  const result = { ...DEFAULT_LIMITS, ...input };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw generationError(`Invalid ${key} limit.`, "INVALID_LIMIT");
  }
  return result;
}

export function assertClonePlatform(): void {
  if (process.platform !== "darwin") {
    throw generationError("Writable supervised generations require macOS clonefile support; no ordinary-copy fallback is allowed.", "CLONE_PLATFORM_UNSUPPORTED");
  }
}

export function generationError(message: string, code: string): SupervisedWorkspaceGenerationError {
  return new SupervisedWorkspaceGenerationError(message, code);
}

export function limitError(kind: string, value: number): SupervisedWorkspaceGenerationError {
  return generationError(`Supervised generation ${kind} exceeded its limit (${value}).`, "GENERATION_LIMIT_EXCEEDED");
}

export function compareUtf8(a: string, b: string): number {
  return Buffer.from(a).compare(Buffer.from(b));
}

export function splitNul(buffer: Buffer): string[] {
  return splitNulBuffer(buffer).map(decodeGitPath);
}

export function decodeGitPath(value: Buffer): string {
  const decoded = value.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(value)) {
    throw generationError("Git returned a path that is not valid UTF-8.", "UNSUPPORTED_GIT_PATH_ENCODING");
  }
  return decoded;
}

export function splitNulBuffer(buffer: Buffer): Buffer[] {
  const result: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) result.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start < buffer.length) result.push(buffer.subarray(start));
  return result;
}

export async function fsyncDirectory(directory: string): Promise<void> {
  const descriptor = await open(directory, fsConstants.O_RDONLY);
  try { await descriptor.sync(); } finally { await descriptor.close(); }
}

export async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (isErrno(error, "ENOENT")) return false; throw error; }
}

export async function invokeFailpoint(
  handler: SupervisedWorkspaceGenerationFailpointHandler | undefined,
  point: SupervisedWorkspaceGenerationFailpoint,
  manifestPath: string,
): Promise<void> {
  await handler?.(point, manifestPath);
}

export function isErrno(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

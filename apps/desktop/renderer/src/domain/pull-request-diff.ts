import type { DesktopPullRequestDiff, DesktopPullRequestDiffResult } from "../../../electron/ipc-types/room";
import type { WorkspaceChangedFile, WorkspaceChangeSummary } from "../../../../../shared/workspace-change-summary.mjs";
import { createWorkspaceDiffIndex, readWorkspaceDiffPage, type WorkspaceDiffPageOptions } from "./workspace-diff";

export const PR_FILE_LIMIT = 100;
export const PR_PATCH_LIMIT = 128 * 1024;
export type PullRequestFileNotice = { title: string; detail: string };
const omitted: PullRequestFileNotice = { title: "Patch unavailable", detail: "GitHub did not provide a text patch for this file. Open on GitHub to inspect it." };
const tooLarge: PullRequestFileNotice = { title: "Too large to show here", detail: "This file’s patch exceeds 128 KiB. Open on GitHub to read its changes." };

export function pullRequestReference(url: string | null, repository: string | null): { number: number; url: string } | null {
  if (!url || !repository) return null;
  const repo = repository.replace(/^https:\/\//, "").replace(/^github\.com\//, "").replace(/\/$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  try {
    const parsed = new URL(url);
    const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/(?:files|commits|checks))?\/?$/.exec(parsed.pathname);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port || parsed.username || parsed.password
      || !match || `${match[1]}/${match[2]}`.toLowerCase() !== repo.toLowerCase()) return null;
    const number = Number(match[3]);
    return Number.isSafeInteger(number) ? { number, url: `https://github.com/${repo}/pull/${number}/files` } : null;
  } catch { return null; }
}

export function pullRequestDiffNotice(code: string): string {
  return ({
    not_connected: "This room has no connected GitHub repository.",
    installation_inactive: "The GitHub connection is inactive. Ask the repository owner to reconnect it.",
    forbidden: "You no longer have access to this repository, or GitHub has withdrawn permission.",
    rate_limited: "GitHub is receiving too many requests. Try again later.",
    not_found: "This pull request is no longer available on GitHub.",
    not_associated: "This pull request has not appeared in this room’s repository events yet.",
    too_large: "This pull request is too large to show here. Open on GitHub to read its changes.",
    moved: "The pull request changed while loading. Try again.",
    sha_mismatch: "This room has not received the latest pull request update yet. Try again shortly.",
    timeout: "GitHub took too long to respond. Try again.",
    bridge_unavailable: "Restart LetAgents Desktop to load the changes viewer.",
  } as Record<string, string>)[code] ?? "The changes could not be loaded. Try again or open on GitHub.";
}

// Decode Git's quoted UTF-8 paths (including octal bytes), never HTML.
function gitPath(value: string): string {
  if (!value.startsWith('"')) return value;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const source = value.slice(1, -1);
  for (let i = 0; i < source.length;) {
    const octal = source[i] === "\\" ? /^\\([0-7]{1,3})/.exec(source.slice(i)) : null;
    if (octal) { bytes.push(parseInt(octal[1], 8)); i += octal[0].length; continue; }
    if (source[i] === "\\") {
      const char = source[++i];
      bytes.push(...encoder.encode(({ t: "\t", n: "\n", r: "\r" } as Record<string, string>)[char] ?? char)); i++;
    } else {
      const char = String.fromCodePoint(source.codePointAt(i)!);
      bytes.push(...encoder.encode(char)); i += char.length;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function describeHeader(header: string): WorkspaceChangedFile | null {
  const lines = header.split("\n");
  // Literal tabs delimit header metadata; tabs in filenames are Git-quoted.
  const target = lines.find(line => line.startsWith("+++ "))?.split("\t", 1)[0];
  const source = lines.find(line => line.startsWith("--- "))?.split("\t", 1)[0];
  const renamed = lines.find(line => line.startsWith("rename to "));
  const previous = lines.find(line => line.startsWith("rename from "));
  const pair = /^diff --git ("(?:[^"\\]|\\.)*"|a\/.+) ("(?:[^"\\]|\\.)*"|b\/.+)$/.exec(lines[0]);
  const path = renamed ? gitPath(renamed.slice(10))
    : target && target !== "+++ /dev/null" ? gitPath(target.slice(4)).replace(/^b\//, "")
      : source ? gitPath(source.slice(4)).replace(/^a\//, "")
        : pair ? gitPath(pair[2]).replace(/^b\//, "") : null;
  if (!path || path.length > 4096) return null;
  return {
    path, previous_path: previous ? gitPath(previous.slice(12)) : null,
    status: renamed ? "renamed" : lines.some(line => line.startsWith("new file mode ")) ? "added"
      : lines.some(line => line.startsWith("deleted file mode ")) ? "deleted" : "modified",
    additions: 0, deletions: 0,
    binary: lines.some(line => line.startsWith("Binary files ") || line === "GIT binary patch"),
  };
}

function changedFile(file: NonNullable<DesktopPullRequestDiff["file_list"]>["files"][number]): WorkspaceChangedFile {
  const status = file.status === "removed" ? "deleted" : file.status;
  return { ...file, binary: false, status: (["added", "modified", "deleted", "renamed", "copied", "typechange"].includes(status)
    ? status : "unknown") as WorkspaceChangedFile["status"] };
}

export type PullRequestDiffModel = Awaited<ReturnType<typeof buildPullRequestDiffModel>>;

// Scan only file boundaries and small headers, yielding between batches. Code lines
// are indexed only when that file is selected, and only below the per-file cap.
export async function buildPullRequestDiffModel(
  value: DesktopPullRequestDiff,
  active: () => boolean = () => true,
  yieldToUi: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 0)),
) {
  const files = value.file_list?.files.slice(0, PR_FILE_LIMIT).map(changedFile) ?? [];
  const byPath = new Map(files.map(file => [file.path, file]));
  const ranges = new Map<string, { start: number; end: number }>();
  const notices: Record<string, PullRequestFileNotice> = Object.create(null);
  const boundary = /^diff --git /gm;
  let current = boundary.exec(value.diff), count = 0;
  while (current) {
    if (!active()) throw new Error("closed");
    const next = boundary.exec(value.diff), end = next?.index ?? value.diff.length;
    const header = value.diff.slice(current.index, Math.min(end, current.index + 16 * 1024)).split("\n@@ ")[0];
    const described = describeHeader(header);
    count++;
    if (described) {
      if (!value.file_list && files.length < PR_FILE_LIMIT) { files.push(described); byPath.set(described.path, described); }
      const file = byPath.get(described.path);
      if (file) {
        file.binary = described.binary;
        ranges.set(file.path, { start: current.index, end });
      }
    }
    current = next;
    if (count % 32 === 0) await yieldToUi();
  }
  for (const file of files) {
    const range = ranges.get(file.path);
    if (file.binary) notices[file.path] = { title: "Binary file changed", detail: "A text preview is not available for this file. Open on GitHub to inspect it." };
    else if (!range) notices[file.path] = omitted;
    // UTF-8 bytes >= UTF-16 units for valid GitHub text. Only encode small sections.
    else if (range.end - range.start > PR_PATCH_LIMIT) notices[file.path] = tooLarge;
  }
  const total = Math.max(files.length, value.file_list?.total_files ?? count);
  const snapshot: WorkspaceChangeSummary = {
    state: "ready", captured_at: "", branch: null, base_revision: value.head_sha,
    files, additions: files.reduce((n, file) => n + file.additions, 0),
    deletions: files.reduce((n, file) => n + file.deletions, 0),
    hidden_files: total - files.length, patch: "", patch_truncated: false,
  };
  let selected: { path: string; index: ReturnType<typeof createWorkspaceDiffIndex> } | null = null;
  function loadPage(path: string, options: WorkspaceDiffPageOptions) {
    const empty = { lines: [], nextOffset: null, included: false };
    if (!active() || notices[path]) return Promise.resolve(empty);
    if (selected?.path !== path) {
      const range = ranges.get(path), file = byPath.get(path);
      if (!range || !file) return Promise.resolve(empty);
      const patch = value.diff.slice(range.start, range.end);
      if (new TextEncoder().encode(patch).length > PR_PATCH_LIMIT) {
        notices[path] = tooLarge;
        return Promise.resolve(empty);
      }
      // An omitted hunk must not masquerade as a metadata-only change.
      const metadataOnly = /\nsimilarity index 100%\n/.test(patch) || (/\nold mode \d+/.test(patch) && /\nnew mode \d+/.test(patch));
      if (!/\n@@ /.test(patch) && (file.additions > 0 || file.deletions > 0 || (!value.file_list && !metadataOnly))) {
        notices[path] = omitted;
        return Promise.resolve(empty);
      }
      selected = { path, index: createWorkspaceDiffIndex(patch, [file]) };
    }
    return Promise.resolve(readWorkspaceDiffPage(selected.index, path, options));
  }
  return { snapshot, notices, loadPage, fileListUnavailable: !value.file_list };
}

export type PullRequestDiffState = { loading: boolean; model: PullRequestDiffModel | null; error: string | null; headSha: string | null };
export function createPullRequestDiffSession(
  fetchDiff: (room: string, number: number) => Promise<DesktopPullRequestDiffResult>,
  changed: (state: PullRequestDiffState) => void,
) {
  let revision = 0;
  const clear = () => changed({ loading: false, model: null, error: null, headSha: null });
  return {
    close() { revision++; clear(); },
    async load(room: string, number: number) {
      const request = ++revision;
      const active = () => request === revision;
      changed({ loading: true, model: null, error: null, headSha: null });
      try {
        const result = await fetchDiff(room, number);
        if (!active()) return;
        if (!result.ok) { changed({ loading: false, model: null, error: pullRequestDiffNotice(result.code), headSha: null }); return; }
        const model = await buildPullRequestDiffModel(result.value, active);
        if (active()) changed({ loading: false, model, error: null, headSha: result.value.head_sha });
      } catch {
        if (active()) changed({ loading: false, model: null, error: pullRequestDiffNotice("unavailable"), headSha: null });
      }
    },
  };
}

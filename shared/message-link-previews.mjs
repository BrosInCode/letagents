export const LINK_PREVIEW_BATCH_LIMIT = 50;
export const LINK_PREVIEW_MESSAGE_LIMIT = 3;

export function parseGitHubLinkReference(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password) return null;
    const match = /^\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (!match) return null;
    const number = Number(match[4]);
    if (!Number.isSafeInteger(number)) return null;
    const repository = `${match[1]}/${match[2]}`.toLowerCase();
    const kind = match[3] === "pull" ? "pull" : "issue";
    return { repository, kind, number, url: `https://github.com/${repository}/${match[3]}/${number}` };
  } catch { return null; }
}

export function normalizePreviewRepository(value) {
  if (typeof value !== "string") return null;
  const name = value.replace(/^https:\/\//i, "").replace(/^github\.com\//i, "").replace(/\/$/, "");
  return /^[\w.-]+\/[\w.-]+$/.test(name) ? name.toLowerCase() : null;
}

export function linkPreviewKey(reference) { return `${reference.kind}:${reference.number}`; }

export function parseLinkPreviewReferences(value) {
  if (!Array.isArray(value) || value.length > LINK_PREVIEW_BATCH_LIMIT) return null;
  const references = new Map();
  for (const ref of value) {
    if (!ref || typeof ref !== "object" || Object.keys(ref).length !== 2
      || !["pull", "issue"].includes(ref.kind) || !Number.isSafeInteger(ref.number) || ref.number <= 0) return null;
    references.set(linkPreviewKey(ref), { kind: ref.kind, number: ref.number });
  }
  return [...references.values()];
}

export function eligibleLinkPreviewReferences(urls, repository) {
  const repo = normalizePreviewRepository(repository);
  if (!repo) return [];
  const refs = new Map();
  for (const url of urls) {
    const ref = parseGitHubLinkReference(url);
    if (!ref || ref.repository !== repo) continue;
    refs.set(linkPreviewKey(ref), { kind: ref.kind, number: ref.number });
    if (refs.size === LINK_PREVIEW_MESSAGE_LIMIT) break;
  }
  return [...refs.values()];
}

/** State is a last-observed snapshot, never a request to GitHub. */
export function linkPreviewState(state, metadata) {
  if (state === "merged" || metadata?.merged === true) return "merged";
  if (state === "closed") return "closed";
  if (state === "draft" || state === "open" && metadata?.draft === true) return "draft";
  return state === "open" ? "open" : null;
}

export function linkPreviewPresentation(preview) {
  const pull = preview.kind === "pull";
  return {
    kind: pull ? "pull-request" : "issue",
    kindLabel: pull ? "Pull request" : "Issue",
    tone: preview.state === "merged" ? "emerald" : preview.state === "closed" ? "slate" : preview.state === "draft" ? "amber" : "violet",
    statusLabel: preview.state,
    headline: `#${preview.number} ${preview.title}`,
    detail: null, repository: preview.repository, taskId: null,
    url: preview.url, urlLabel: pull ? "Open pull request" : "Open issue",
  };
}

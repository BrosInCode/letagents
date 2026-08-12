import { githubRequest, mintInstallationToken } from "../github/app-client.js";
import { getGitHubAppConfig, type GitHubAppConfig } from "../github/config.js";

const GITHUB_API = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const LOOKUP_MAX_PAGES = 3;

export type GitHubReviewVerdict = "approve" | "request_changes" | "comment";

export interface GitHubReviewEffectRequest {
  owner: string;
  repo: string;
  pull_number: number;
  expected_head_sha: string;
  installation_id: string;
  verdict: GitHubReviewVerdict;
  body: string;
}

export type GitHubReviewCreateResult =
  | {
      kind: "succeeded";
      external_id: string;
      external_url: string | null;
      response_payload: Record<string, unknown>;
    }
  | { kind: "definite_failure"; error: string }
  | { kind: "ambiguous"; error: string };

export type GitHubReviewLookupResult =
  | {
      kind: "found";
      external_id: string;
      external_url: string | null;
      response_payload: Record<string, unknown>;
    }
  | { kind: "not_found" };

export interface GitHubReviewProvider {
  create(request: GitHubReviewEffectRequest, correlationKey: string): Promise<GitHubReviewCreateResult>;
  lookup(request: GitHubReviewEffectRequest, correlationKey: string): Promise<GitHubReviewLookupResult>;
}

function marker(correlationKey: string): string {
  return `<!-- letagents-effect:${correlationKey} -->`;
}

function withoutReservedMarkers(body: string): string {
  return body.replace(/<!--\s*letagents-effect:[^>]*-->/gi, "").trim();
}

function reviewEvent(verdict: GitHubReviewVerdict): "APPROVE" | "REQUEST_CHANGES" | "COMMENT" {
  if (verdict === "approve") return "APPROVE";
  if (verdict === "request_changes") return "REQUEST_CHANGES";
  return "COMMENT";
}

function responsePayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function externalResult(value: Record<string, unknown>) {
  return {
    external_id: String(value.id ?? ""),
    external_url: typeof value.html_url === "string" ? value.html_url : null,
    response_payload: value,
  };
}

async function responseError(response: Response): Promise<string> {
  const text = (await response.text()).slice(0, 2_000);
  return `GitHub review request failed with ${response.status}${text ? `: ${text}` : ""}`;
}

function lastPageFromLinkHeader(value: string | null): number | null {
  if (!value) return null;
  for (const part of value.split(",")) {
    if (!/;\s*rel="last"\s*$/.test(part.trim())) continue;
    const target = part.match(/<([^>]+)>/)?.[1];
    if (!target) continue;
    try {
      const page = Number(new URL(target).searchParams.get("page"));
      if (Number.isSafeInteger(page) && page > 0) return page;
    } catch {
      // Ignore malformed provider pagination metadata and use the bounded
      // forward fallback below.
    }
  }
  return null;
}

export function createGitHubReviewProvider(options: {
  config?: GitHubAppConfig;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  mintToken?: (request: GitHubReviewEffectRequest) => Promise<string>;
} = {}): GitHubReviewProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function tokenFor(request: GitHubReviewEffectRequest): Promise<string> {
    if (options.mintToken) return options.mintToken(request);
    return mintInstallationToken({
      config: options.config ?? await getGitHubAppConfig(),
      installationId: request.installation_id,
      fetchImpl,
      timeoutMs,
    });
  }

  return {
    async create(request, correlationKey) {
      let token: string;
      try {
        token = await tokenFor(request);
        const pullResponse = await githubRequest({
          url: `${GITHUB_API}/repos/${encodeURIComponent(request.owner)}/${encodeURIComponent(request.repo)}/pulls/${request.pull_number}`,
          token,
          fetchImpl,
          timeoutMs,
        });
        if (!pullResponse.ok) {
          return { kind: "definite_failure", error: await responseError(pullResponse) };
        }
        const pull = responsePayload(await pullResponse.json());
        const head = responsePayload(pull.head);
        const currentHeadSha = typeof head.sha === "string" ? head.sha.toLowerCase() : "";
        if (!/^[0-9a-f]{40}$/.test(currentHeadSha)) {
          return {
            kind: "definite_failure",
            error: "GitHub pull request head preflight returned no valid 40-hex SHA; review was not created.",
          };
        }
        if (currentHeadSha !== request.expected_head_sha.toLowerCase()) {
          return {
            kind: "definite_failure",
            error: `GitHub pull request head changed: expected ${request.expected_head_sha}, current ${currentHeadSha}; review was not created.`,
          };
        }
      } catch (error) {
        return {
          kind: "definite_failure",
          error: error instanceof Error
            ? `GitHub pull request head preflight failed before review creation: ${error.message}`
            : "GitHub pull request head preflight failed before review creation.",
        };
      }

      try {
        const body = withoutReservedMarkers(request.body);
        const response = await githubRequest({
          url: `${GITHUB_API}/repos/${encodeURIComponent(request.owner)}/${encodeURIComponent(request.repo)}/pulls/${request.pull_number}/reviews`,
          method: "POST",
          token,
          fetchImpl,
          timeoutMs,
          body: {
            event: reviewEvent(request.verdict),
            commit_id: request.expected_head_sha,
            body: `${body}${body ? "\n\n" : ""}${marker(correlationKey)}`,
          },
        });
        if (!response.ok) {
          const error = await responseError(response);
          return response.status >= 400 && response.status < 500
            ? { kind: "definite_failure", error }
            : { kind: "ambiguous", error };
        }
        const payload = responsePayload(await response.json());
        const result = externalResult(payload);
        if (!result.external_id) {
          return { kind: "ambiguous", error: "GitHub accepted the review but returned no review id." };
        }
        return { kind: "succeeded", ...result };
      } catch (error) {
        return {
          kind: "ambiguous",
          error: error instanceof Error ? error.message : "GitHub review request outcome is unknown.",
        };
      }
    },

    async lookup(request, correlationKey) {
      const token = await tokenFor(request);
      const expectedMarker = marker(correlationKey);
      const fetchPage = async (page: number) => {
        const response = await githubRequest({
          url: `${GITHUB_API}/repos/${encodeURIComponent(request.owner)}/${encodeURIComponent(request.repo)}/pulls/${request.pull_number}/reviews?per_page=100&page=${page}`,
          token,
          fetchImpl,
          timeoutMs,
        });
        if (!response.ok) throw new Error(await responseError(response));
        const payload = await response.json();
        const reviews = Array.isArray(payload) ? payload : [];
        for (const candidate of reviews) {
          const review = responsePayload(candidate);
          const reviewedCommitId = typeof review.commit_id === "string"
            ? review.commit_id.toLowerCase()
            : "";
          if (
            typeof review.body === "string"
            && review.body.includes(expectedMarker)
            && reviewedCommitId === request.expected_head_sha.toLowerCase()
          ) {
            const result = externalResult(review);
            if (result.external_id) return { result: { kind: "found" as const, ...result }, response, reviews };
          }
        }
        return { result: null, response, reviews };
      };

      const first = await fetchPage(1);
      if (first.result) return first.result;
      const lastPage = lastPageFromLinkHeader(first.response.headers.get("link"));
      const pages = lastPage && lastPage > 1
        ? Array.from(
            { length: Math.min(LOOKUP_MAX_PAGES, lastPage - 1) },
            (_, index) => lastPage - index,
          )
        : first.reviews.length === 100
          ? Array.from({ length: LOOKUP_MAX_PAGES - 1 }, (_, index) => index + 2)
          : [];
      for (const page of pages) {
        const candidate = await fetchPage(page);
        if (candidate.result) return candidate.result;
        if (!lastPage && candidate.reviews.length < 100) break;
      }
      return { kind: "not_found" };
    },
  };
}

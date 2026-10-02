export const LINK_PREVIEW_BATCH_LIMIT: 50;
export const LINK_PREVIEW_MESSAGE_LIMIT: 3;
export interface LinkPreviewReference { kind: "pull" | "issue"; number: number }
export interface GitHubLinkReference extends LinkPreviewReference { repository: string; url: string }
export interface MessageLinkPreview extends GitHubLinkReference { title: string; state: "merged" | "closed" | "draft" | "open" }
export interface MessageLinkPreviewsResponse { room_id: string; previews: MessageLinkPreview[]; available?: boolean }
export function parseGitHubLinkReference(value: unknown): GitHubLinkReference | null;
export function normalizePreviewRepository(value: unknown): string | null;
export function linkPreviewKey(reference: LinkPreviewReference): string;
export function parseLinkPreviewReferences(value: unknown): LinkPreviewReference[] | null;
export function eligibleLinkPreviewReferences(urls: readonly string[], repository: string | null): LinkPreviewReference[];
export function linkPreviewState(state: unknown, metadata?: { merged?: unknown; draft?: unknown } | null): MessageLinkPreview["state"] | null;
export function linkPreviewPresentation(preview: MessageLinkPreview): {
  kind: "pull-request" | "issue"; kindLabel: string; tone: "emerald" | "slate" | "amber" | "violet";
  statusLabel: string; headline: string; detail: null; repository: string; taskId: null; url: string; urlLabel: string;
};

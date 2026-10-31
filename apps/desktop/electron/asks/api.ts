import { apiFetch, DesktopApiError } from "../main/auth.js";
import type {
  DesktopAgentAsk, DesktopAgentAskLink, DesktopAgentAskModel, DesktopAgentAskProposal, DesktopAgentAskWorkspace, DesktopCreateAgentAskInput,
} from "../ipc-types/asks.js";

type Json = Record<string, unknown>;
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
const room = (roomId: string) => `/rooms/${encodeURIComponent(roomId)}/agent-asks`;
const link = (token: string, action = "") => `/agent-asks/link/${encodeURIComponent(token)}${action ? `/${action}` : ""}`;

/** The plain sentence the server wrote for people, or a generic fallback. */
export function askErrorMessage(error: unknown): string {
  if (error instanceof DesktopApiError && error.payload?.error) return String(error.payload.error);
  if (error instanceof AskGiveError) return error.message;
  return "Couldn't reach LetAgents. Check your connection and try again.";
}

/** A failure the giver should read as-is. */
export class AskGiveError extends Error {
  constructor(message: string) { super(message); this.name = "AskGiveError"; }
}

export const askApi = {
  models: async () => (await apiFetch<{ models: DesktopAgentAskModel[] }>("/agent-asks/models", undefined, { credential: "none" })).models,
  create: async (input: DesktopCreateAgentAskInput) => apiFetch<{ ask: DesktopAgentAsk; link: string }>(room(input.roomId), json({
    provider_id: input.providerId, model: input.model, ...(input.amountPercent ? { amount_percent: input.amountPercent } : {}),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
  })),
  listRoom: async (roomId: string) => (await apiFetch<{ asks: DesktopAgentAsk[] }>(room(roomId))).asks,
  listMine: async () => (await apiFetch<{ asks: DesktopAgentAsk[] }>("/desktop/agent-asks")).asks,
  act: async (askId: string, action: "cancel" | "accept" | "decline" | "remove") =>
    (await apiFetch<{ ask: DesktopAgentAsk }>(`/agent-asks/${encodeURIComponent(askId)}/${action}`, json({}))).ask,
  preview: async (token: string) => apiFetch<DesktopAgentAskLink>(link(token)),
  claim: async (token: string) => (await apiFetch<{ ask: DesktopAgentAsk }>(link(token, "claim"), json({}))).ask,
  release: async (token: string, cantHelp: boolean) => apiFetch<Json>(link(token, "release"), json({ cant_help: cantHelp })),
  launchAuthority: async (token: string, body: Json) => apiFetch<Json>(link(token, "launch-authority"), json(body)),
  joined: async (token: string, roomAgentSessionId: string) =>
    (await apiFetch<{ ask: DesktopAgentAsk }>(link(token, "joined"), json({ room_agent_session_id: roomAgentSessionId }))).ask,
  workspace: async (askId: string) => apiFetch<DesktopAgentAskWorkspace>(`/agent-asks/${encodeURIComponent(askId)}/workspace`),
  decide: async (askId: string, proposalId: string, approve: boolean) =>
    (await apiFetch<{ proposal: DesktopAgentAskProposal }>(`/agent-asks/${encodeURIComponent(askId)}/proposals/${encodeURIComponent(proposalId)}/${approve ? "approve" : "decline"}`, json({}))).proposal,
  end: async (token: string, reason: "amount_used" | "provider_limit") => apiFetch<Json>(link(token, "end"), json({ reason })),
};
export type AskApi = typeof askApi;

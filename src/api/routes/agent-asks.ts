import type { Express, Response } from "express";

import type { AuthenticatedRequest } from "../http/helpers.js";
import { isAppSession } from "../request/app-session.js";
import { isProjectAdmin } from "../db/auth/project-admins.js";
import { getProjectById } from "../db.js";
import { getGitRoomBindingForRoom } from "../db/git-room-bindings.js";
import { isGitHubRepoWriter } from "../github/repo-access.js";
import { resolveParticipantRoom } from "./rooms/messages/helpers.js";
import type { RoomMessageRouteDeps } from "./rooms/messages/types.js";
import {
  ASKABLE_MODELS, ASK_NOTE_MAX, findAskableModel, parseAmountPercent, type AgentAskEndReason,
} from "../agent-asks/lifecycle.js";
import * as asks from "../agent-asks/store.js";
import * as workspace from "../agent-asks/workspace.js";
import type { AgentAsk } from "../agent-asks/store.js";

const databaseStore = {
  create: asks.createAsk, byToken: asks.getAskByToken, byId: asks.getAskById, listRoom: asks.listRoomAsks,
  listAccount: asks.listAccountAsks, cancel: asks.cancelAsk, claim: asks.claimAsk, release: asks.releaseClaim,
  authority: asks.createAskLaunchAuthority, joined: asks.acknowledgeAskJoin, accept: asks.acceptSubstitute,
  decline: asks.declineSubstitute, end: asks.endAsk, name: asks.personName, avatar: asks.personAvatarUrl, isAdmin: isProjectAdmin,
  room: getProjectById, forWorker: asks.askForWorker, canWrite: canWriteRoomRepo,
  files: workspace.listFiles, read: workspace.readRepoFile, search: workspace.searchRepo, propose: workspace.proposeChange,
  proposals: workspace.listProposals, reads: workspace.listReads, decide: workspace.decideProposal,
};
export type AgentAskStore = typeof databaseStore;

/**
 * In a room backed by a GitHub repo, bringing in an outside agent and approving
 * its changes (which the GitHub App pushes) need write access to that repo,
 * checked with GitHub now, or room admin. Rooms with no repo have no such gate.
 */
async function canWriteRoomRepo(roomId: string, account: { account_id: string; provider?: string; login?: string; provider_access_token?: string | null }): Promise<boolean> {
  const binding = await getGitRoomBindingForRoom(roomId);
  if (!binding) return true;
  if (await isProjectAdmin(roomId, account.account_id)) return true;
  if (binding.provider !== "github" || account.provider !== "github" || !account.login) return false;
  return isGitHubRepoWriter({ roomName: `github.com/${binding.repository_full_name}`, login: account.login, accessToken: account.provider_access_token ?? "" });
}

const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const ASK_ID = /^ask_[0-9a-f-]{36}$/;

function person(req: AuthenticatedRequest, res: Response): string | null {
  if (isAppSession(req)) return req.sessionAccount!.account_id;
  res.status(req.authKind ? 403 : 401).json({ code: "person_required", error: "Sign in to LetAgents to continue." });
  return null;
}

function fail(res: Response, error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const known: Record<string, [number, string]> = {
    ask_not_claimed: [409, "This request is no longer reserved for you. Open the link again."],
    ask_worker_not_ready: [409, "The agent hasn't joined the room yet. Try again in a moment."],
    agent_identity_not_owned: [403, "That agent isn't yours."],
    gift_limit: [409, "You're already giving 3 agents. Wait for one to finish, then try again."],
  };
  if (known[code]) { res.status(known[code][0]).json({ code, error: known[code][1] }); return; }
  if (error instanceof workspace.AskWorkspaceError) { res.status(error.status).json({ code: error.code, error: error.message }); return; }
  const pg = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  if (pg === "55P03") { res.status(503).json({ code: "ask_busy", error: "Busy right now. Try again." }); return; }
  console.error("[agent asks]", error);
  res.status(500).json({ error: "Something went wrong. Try again." });
}

/** Why a link can't be used, in the words the giver sees (spec "What can go wrong"). */
async function unusable(ask: AgentAsk, accountId: string | null, store: AgentAskStore): Promise<[number, string, string] | null> {
  const asker = await store.name(ask.asker_account_id);
  if (ask.state === "expired") return [410, "ask_expired", "This request expired."];
  if (ask.state === "cancelled") return [410, "ask_cancelled", `${asker} cancelled this request.`];
  if (ask.state === "claimed" && ask.giver_account_id !== accountId) return [409, "ask_claimed", "Someone is adding this agent right now."];
  if (ask.state !== "open" && ask.state !== "claimed") return [409, "ask_used", `Someone already helped ${asker}. Thanks for offering.`];
  return null;
}

async function summary(ask: AgentAsk, viewer: string | null, store: AgentAskStore, detail: boolean) {
  const base = {
    id: ask.id, state: ask.state, asker: await store.name(ask.asker_account_id),
    provider_id: ask.provider_id, model: ask.model, model_label: ask.model_label,
    amount_percent: ask.amount_percent, expires_at: ask.expires_at,
  };
  if (!detail) return base;
  const room = await store.room(ask.room_id).catch(() => null);
  return {
    ...base, asker_avatar_url: await store.avatar(ask.asker_account_id), note: ask.note, room_display_name: room?.display_name ?? null,
    is_asker: viewer === ask.asker_account_id, is_giver: viewer !== null && viewer === ask.giver_account_id,
    giver: ask.giver_account_id ? await store.name(ask.giver_account_id) : null,
    given_model_label: ask.given_model_label, given_amount_percent: ask.given_amount_percent,
    ended_reason: ask.ended_reason, created_at: ask.created_at, updated_at: ask.updated_at,
  };
}

function linkFor(req: AuthenticatedRequest, token: string): string {
  const origin = process.env.LETAGENTS_PUBLIC_URL ?? `${req.protocol}://${req.get?.("host") ?? "letagents.chat"}`;
  return `${origin.replace(/\/$/, "")}/ask/${token}`;
}

export function registerAgentAskRoutes(app: Express, deps: RoomMessageRouteDeps, store: AgentAskStore = databaseStore): void {
  app.get("/agent-asks/models", (_req, res) => { res.json({ models: ASKABLE_MODELS }); });

  app.post(/^\/rooms\/(.+)\/agent-asks$/, async (req: AuthenticatedRequest, res) => {
    const accountId = person(req, res); if (!accountId) return;
    try {
      const room = await resolveParticipantRoom(req, res, deps); if (!room) return;
      if (!await store.canWrite(room.id, req.sessionAccount as never)) {
        res.status(403).json({ code: "write_required", error: "Only people who can push to this room's repo can ask for an agent here." });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const model = findAskableModel(body.provider_id, body.model);
      const amount = parseAmountPercent(body.amount_percent, { required: false });
      const note = typeof body.note === "string" ? body.note.trim() : body.note === undefined ? "" : null;
      if (!model || amount === "invalid" || note === null || note.length > ASK_NOTE_MAX
        || Object.keys(body).some(key => !["provider_id", "model", "amount_percent", "note"].includes(key))) {
        res.status(400).json({ code: "invalid_ask", error: "Choose a model from the list, an amount from 1 to 100%, and a short note." });
        return;
      }
      const result = await store.create({ askerAccountId: accountId, roomId: room.id, providerId: model.providerId,
        model: model.model, modelLabel: model.label, amountPercent: amount, note });
      if (result.error !== null) {
        res.status(409).json({ code: result.error, error: "You already have 5 open requests. Cancel one to ask again." });
        return;
      }
      res.status(201).json({ ask: await summary(result.ask, accountId, store, true), link: linkFor(req, result.token) });
    } catch (error) { fail(res, error); }
  });

  app.get(/^\/rooms\/(.+)\/agent-asks$/, async (req: AuthenticatedRequest, res) => {
    const accountId = person(req, res); if (!accountId) return;
    try {
      const room = await resolveParticipantRoom(req, res, deps); if (!room) return;
      const rows = await store.listRoom(room.id);
      res.json({ asks: await Promise.all(rows.map(row => summary(row, accountId, store, true))) });
    } catch (error) { fail(res, error); }
  });

  app.get("/desktop/agent-asks", async (req: AuthenticatedRequest, res) => {
    const accountId = person(req, res); if (!accountId) return;
    try {
      const rows = await store.listAccount(accountId);
      res.json({ asks: await Promise.all(rows.map(row => summary(row, accountId, store, true))) });
    } catch (error) { fail(res, error); }
  });

  /** Link preview. Anyone sees who asked for which model; signed-in people also see the note and room. */
  app.get("/agent-asks/link/:token", async (req: AuthenticatedRequest, res) => {
    const token = String(req.params.token ?? "");
    if (!TOKEN.test(token)) { res.status(404).json({ code: "ask_not_found", error: "This link isn't valid." }); return; }
    try {
      const ask = await store.byToken(token);
      if (!ask) { res.status(404).json({ code: "ask_not_found", error: "This link isn't valid." }); return; }
      const viewer = isAppSession(req) ? req.sessionAccount!.account_id : null;
      const blocked = await unusable(ask, viewer, store);
      res.json({ ask: await summary(ask, viewer, store, viewer !== null), unavailable: blocked ? { code: blocked[1], error: blocked[2] } : null });
    } catch (error) { fail(res, error); }
  });

  async function withLink(req: AuthenticatedRequest, res: Response) {
    const accountId = person(req, res); if (!accountId) return null;
    const token = String(req.params.token ?? "");
    const ask = TOKEN.test(token) ? await store.byToken(token) : null;
    if (!ask) { res.status(404).json({ code: "ask_not_found", error: "This link isn't valid." }); return null; }
    return { accountId, ask };
  }

  app.post("/agent-asks/link/:token/claim", async (req: AuthenticatedRequest, res) => {
    try {
      const found = await withLink(req, res); if (!found) return;
      const blocked = await unusable(found.ask, found.accountId, store);
      if (blocked) { res.status(blocked[0]).json({ code: blocked[1], error: blocked[2] }); return; }
      const claimed = await store.claim(found.ask, found.accountId);
      if (!claimed) { res.status(409).json({ code: "ask_claimed", error: "Someone is adding this agent right now." }); return; }
      res.json({ ask: await summary(claimed, found.accountId, store, true) });
    } catch (error) { fail(res, error); }
  });

  app.post("/agent-asks/link/:token/release", async (req: AuthenticatedRequest, res) => {
    try {
      const found = await withLink(req, res); if (!found) return;
      const released = await store.release(found.ask, found.accountId, req.body?.cant_help === true);
      res.json({ ok: Boolean(released) });
    } catch (error) { fail(res, error); }
  });

  app.post("/agent-asks/link/:token/launch-authority", async (req: AuthenticatedRequest, res) => {
    try {
      const found = await withLink(req, res); if (!found) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const amount = parseAmountPercent(body.amount_percent, { required: true });
      const text = (value: unknown, max = 200) => typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
      const input = {
        hostId: text(body.host_id), installationId: text(body.installation_id), agentKey: text(body.agent_key),
        providerId: text(body.provider_id, 40), model: body.model === null ? null : text(body.model, 120), label: text(body.model_label, 120),
      };
      if (!input.hostId || !input.installationId || !input.agentKey || !input.providerId || !input.label
        || (body.model !== null && !input.model) || amount === "invalid" || amount === null) {
        res.status(400).json({ code: "invalid_launch", error: "Choose a model and an amount, then try again." });
        return;
      }
      // The label shown in the room comes from LetAgents' list, never from what the giver sends.
      const given = findAskableModel(input.providerId, input.model);
      if (!given) { res.status(400).json({ code: "invalid_launch", error: "Choose a model from the list, then try again." }); return; }
      const result = await store.authority(found.ask, {
        giverAccountId: found.accountId, hostId: input.hostId, installationId: input.installationId,
        agentKey: input.agentKey, givenProviderId: given.providerId, givenModel: given.model,
        givenModelLabel: given.label, givenAmountPercent: amount,
      });
      res.json({ ask: await summary(result.ask, found.accountId, store, true), room_id: result.ask.room_id, grant: result.grant });
    } catch (error) { fail(res, error); }
  });

  app.post("/agent-asks/link/:token/joined", async (req: AuthenticatedRequest, res) => {
    try {
      const found = await withLink(req, res); if (!found) return;
      const sessionId = typeof req.body?.room_agent_session_id === "string" ? req.body.room_agent_session_id : "";
      if (!sessionId) { res.status(400).json({ code: "invalid_join", error: "The agent's room session is missing." }); return; }
      const joined = await store.joined(found.ask, { giverAccountId: found.accountId, roomAgentSessionId: sessionId });
      res.json({ ask: await summary(joined, found.accountId, store, true) });
    } catch (error) { fail(res, error); }
  });

  /** Only the giver's desktop ends a running gift, when its amount or the real limit is used up. */
  app.post("/agent-asks/link/:token/end", async (req: AuthenticatedRequest, res) => {
    try {
      const found = await withLink(req, res); if (!found) return;
      const reason = req.body?.reason;
      if (found.ask.giver_account_id !== found.accountId || (reason !== "amount_used" && reason !== "provider_limit")) {
        res.status(403).json({ code: "not_allowed", error: "An agreement is an agreement: it ends when the amount is used." });
        return;
      }
      const ended = await store.end(found.ask, reason);
      res.json({ ok: Boolean(ended) });
    } catch (error) { fail(res, error); }
  });

  async function askerAction(req: AuthenticatedRequest, res: Response, allowAdmin: boolean) {
    const accountId = person(req, res); if (!accountId) return null;
    const id = String(req.params.id ?? "");
    const ask = ASK_ID.test(id) ? await store.byId(id) : null;
    if (!ask) { res.status(404).json({ code: "ask_not_found", error: "Request not found." }); return null; }
    const allowed = ask.asker_account_id === accountId || (allowAdmin && await store.isAdmin(ask.room_id, accountId));
    if (!allowed) { res.status(403).json({ code: "not_allowed", error: "Only the person who asked can do that." }); return null; }
    return ask;
  }

  const action = (path: string, allowAdmin: boolean, run: (ask: AgentAsk) => Promise<AgentAsk | null>) =>
    app.post(`/agent-asks/:id/${path}`, async (req: AuthenticatedRequest, res) => {
      try {
        const ask = await askerAction(req, res, allowAdmin); if (!ask) return;
        const updated = await run(ask);
        if (!updated) { res.status(409).json({ code: "ask_changed", error: "This request has already changed. Refresh to see where it is." }); return; }
        res.json({ ask: await summary(updated, req.sessionAccount!.account_id, store, true) });
      } catch (error) { fail(res, error); }
    });
  action("cancel", false, ask => store.cancel(ask));
  action("accept", false, ask => store.accept(ask));
  action("decline", false, ask => store.decline(ask));
  action("remove", true, ask => store.end(ask, "removed" satisfies AgentAskEndReason));

  /** The given agent's code tools. The ask comes from the agent's own grant, never from the request. */
  const agentTool = (name: "files" | "read" | "search" | "proposals", run: (ask: AgentAsk, body: Record<string, unknown>) => Promise<unknown>) =>
    app.post(new RegExp(`^\\/rooms\\/(.+)\\/agent-ask-workspace\\/${name}$`), async (req: AuthenticatedRequest, res) => {
      const session = req.authKind === "agent_session" ? req.agentSession : null;
      if (!session) { res.status(403).json({ code: "agent_required", error: "Only a given agent can use these tools." }); return; }
      try {
        const ask = await store.forWorker(session.agent_session_id);
        if (!ask) { res.status(403).json({ code: "not_given", error: "These tools are only for an agent someone gave to this room, while it's active." }); return; }
        res.json({ result: await run(ask, (req.body ?? {}) as Record<string, unknown>) });
      } catch (error) { fail(res, error); }
    });
  agentTool("files", (ask, body) => store.files(ask, body.path));
  agentTool("read", (ask, body) => store.read(ask, body.path));
  agentTool("search", (ask, body) => store.search(ask, body.query));
  agentTool("proposals", async (ask, body) => {
    const proposal = await store.propose(ask, body.summary, body.files, await store.name(ask.giver_account_id));
    return { id: proposal.id, state: proposal.state, message: "Proposed. The person who asked will review it." };
  });

  /** The asker's review: proposed changes and what the agent has seen. */
  app.get("/agent-asks/:id/workspace", async (req: AuthenticatedRequest, res) => {
    try {
      const ask = await askerAction(req, res, true); if (!ask) return;
      const [proposals, reads] = await Promise.all([store.proposals(ask.id), store.reads(ask.id)]);
      res.json({
        proposals: proposals.map(row => ({ id: row.id, summary: row.summary, state: row.state, error: row.error, pr_url: row.pr_url,
          files: (row.files as Array<{ path: string; content: string | null }>).map(file => ({ path: file.path, deleted: file.content === null, content: file.content })),
          created_at: row.created_at })),
        files_seen: reads.map(row => ({ kind: row.kind, target: row.target, blocked: row.blocked, at: row.created_at })),
      });
    } catch (error) { fail(res, error); }
  });
  for (const decision of ["approve", "decline"] as const) {
    app.post(`/agent-asks/:id/proposals/:proposalId/${decision}`, async (req: AuthenticatedRequest, res) => {
      try {
        const ask = await askerAction(req, res, false); if (!ask) return;
        if (decision === "approve" && !await store.canWrite(ask.room_id, req.sessionAccount as never)) {
          res.status(403).json({ code: "write_required", error: "Approving pushes to the repo, so it needs write access to it." });
          return;
        }
        const decided = await store.decide(ask, String(req.params.proposalId ?? ""), decision === "approve");
        if (!decided) { res.status(409).json({ code: "proposal_changed", error: "This change was already reviewed." }); return; }
        res.json({ proposal: { id: decided.id, state: decided.state, error: decided.error, pr_url: decided.pr_url } });
      } catch (error) { fail(res, error); }
    });
  }
}

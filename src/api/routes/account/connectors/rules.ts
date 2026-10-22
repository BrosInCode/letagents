import type { Express, Response } from "express";

import {
  JEV_RULE_DRAFT_MAX_CHARS,
  TRACKER_RULES_PER_CONNECTION_MAX,
  type TrackerProvider,
  type TrackerRuleDraftResult,
  type TrackerRuleList,
  type TrackerRuleView,
} from "../../../../../shared/ticket-connectors.mjs";
import {
  toTrackerRuleView,
  TrackerRuleLimitError,
  trackerRuleStore,
  type TrackerRuleRow,
  type TrackerRuleStore,
} from "../../../connectors/rules/store.js";
import { parseTrackerRuleInput } from "../../../connectors/rules/validate.js";
import { trackerConnectionStore, type TrackerConnectionRow, type TrackerConnectionStore } from "../../../connectors/store.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { createAttemptLimiter, requireAccount } from "./index.js";

/** PR6: Jev turns a sentence into a rule for the editor. */
export type DraftTrackerRule = (input: {
  connection: { id: string; provider: TrackerProvider; status_map: Record<string, string>; jev_linking_enabled: boolean };
  sentence: string;
}) => Promise<TrackerRuleDraftResult>;

export interface TrackerRuleRouteDeps {
  connections: Pick<TrackerConnectionStore, "get">;
  rules: Pick<TrackerRuleStore,
    "list" | "get" | "create" | "update" | "setEnabled" | "delete" | "versions" | "version" | "roomsForConnection">;
  draftRule?: DraftTrackerRule;
}

export function defaultTrackerRuleRouteDeps(): TrackerRuleRouteDeps {
  return {
    connections: trackerConnectionStore,
    rules: trackerRuleStore,
    draftRule: async (input) => (await import("../../../connectors/jev/runtime.js")).draftRuleFromSentenceDefault(input),
  };
}

/** Drafts per account: each one is a Jev call. */
const RULE_DRAFTS_PER_HOUR = 30;

function param(req: AuthenticatedRequest, name: string): string {
  return String((req.params as Record<string, string>)[name] ?? "").trim();
}

/**
 * Tracker rules (ticket connectors PR5). A rule writes to the tracker with
 * the connection's credentials whenever a repo event matches, so only the
 * connection's owner, signed in to the app, may read or change it (the same
 * gate as the connection routes: no owner token, no agent). Every route is
 * scoped to a connection the account owns; another account's connection or
 * rule answers 404.
 *
 * `POST /account/connectors/:id/rules/draft` (PR6) turns a sentence into
 * rule JSON for the editor with Jev, behind the connection's Jev switch. A
 * draft is never saved here: the person presses Save, which sends it through
 * the same validation as any typed rule.
 */
export function registerTrackerRuleRoutes(app: Express, deps: TrackerRuleRouteDeps = defaultTrackerRuleRouteDeps()): void {
  async function ownedConnection(req: AuthenticatedRequest, res: Response): Promise<{ accountId: string; connection: TrackerConnectionRow } | null> {
    const accountId = requireAccount(req, res);
    if (!accountId) return null;
    const connection = await deps.connections.get(param(req, "id"));
    if (!connection || connection.account_id !== accountId) {
      res.status(404).json({ error: "Tracker connection not found." });
      return null;
    }
    return { accountId, connection };
  }

  async function ownedRule(req: AuthenticatedRequest, res: Response): Promise<{ accountId: string; connection: TrackerConnectionRow; rule: TrackerRuleRow } | null> {
    const owned = await ownedConnection(req, res);
    if (!owned) return null;
    const rule = await deps.rules.get(owned.connection.id, param(req, "ruleId"));
    if (!rule) {
      res.status(404).json({ error: "Rule not found." });
      return null;
    }
    return { ...owned, rule };
  }

  /** Validates the body; a rule limited to one room must name a room that imports with this connection. */
  async function parseBody(req: AuthenticatedRequest, res: Response, connectionId: string) {
    const parsed = parseTrackerRuleInput(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return null;
    }
    if (parsed.value.room_id && !(await deps.rules.roomsForConnection(connectionId)).includes(parsed.value.room_id)) {
      res.status(400).json({ error: "That room does not import tickets with this connection. Add a room filter first, or apply the rule to every room." });
      return null;
    }
    return parsed.value;
  }

  const sendRule = (res: Response, row: TrackerRuleRow, status = 200) => {
    const body: { rule: TrackerRuleView } = { rule: toTrackerRuleView(row) };
    res.status(status).json(body);
  };

  const draftLimiter = createAttemptLimiter(RULE_DRAFTS_PER_HOUR, 60 * 60_000);
  app.post("/account/connectors/:id/rules/draft", async (req: AuthenticatedRequest, res) => {
    const owned = await ownedConnection(req, res);
    if (!owned) return;
    const sentence = (req.body as Record<string, unknown> | undefined)?.sentence;
    if (typeof sentence !== "string" || !sentence.trim() || sentence.length > JEV_RULE_DRAFT_MAX_CHARS) {
      res.status(400).json({ error: `Describe the rule in 1 to ${JEV_RULE_DRAFT_MAX_CHARS} characters.` });
      return;
    }
    if (!deps.draftRule) {
      res.status(503).json({ error: "Rule drafting is not available on this server." });
      return;
    }
    if (!owned.connection.jev_linking_enabled) {
      res.status(409).json({ error: "Turn on Jev for this connection to draft rules from a sentence.", code: "jev_disabled" });
      return;
    }
    if (!draftLimiter(owned.accountId)) {
      res.status(429).json({ error: "Too many drafts in the last hour. Write the rule by hand, or try again later." });
      return;
    }
    const result = await deps.draftRule({
      connection: {
        id: owned.connection.id,
        provider: owned.connection.provider as TrackerProvider,
        status_map: owned.connection.status_map,
        jev_linking_enabled: owned.connection.jev_linking_enabled,
      },
      sentence: sentence.trim(),
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  });

  app.get("/account/connectors/:id/rules", async (req: AuthenticatedRequest, res) => {
    const owned = await ownedConnection(req, res);
    if (!owned) return;
    const [rows, rooms] = await Promise.all([
      deps.rules.list(owned.connection.id),
      deps.rules.roomsForConnection(owned.connection.id),
    ]);
    const body: TrackerRuleList = { rules: rows.map(toTrackerRuleView), rooms };
    res.json(body);
  });

  app.post("/account/connectors/:id/rules", async (req: AuthenticatedRequest, res) => {
    const owned = await ownedConnection(req, res);
    if (!owned) return;
    if (owned.connection.provider === "github") {
      res.status(400).json({ error: "Rules do not write to GitHub Issues yet." });
      return;
    }
    const input = await parseBody(req, res, owned.connection.id);
    if (!input) return;
    try {
      sendRule(res, await deps.rules.create(owned.connection.id, owned.accountId, input, TRACKER_RULES_PER_CONNECTION_MAX), 201);
    } catch (error) {
      if (!(error instanceof TrackerRuleLimitError)) throw error;
      res.status(400).json({ error: error.message });
    }
  });

  /** Saves the rule as a new version; the old one stays in the history. */
  app.put("/account/connectors/:id/rules/:ruleId", async (req: AuthenticatedRequest, res) => {
    const owned = await ownedRule(req, res);
    if (!owned) return;
    const input = await parseBody(req, res, owned.connection.id);
    if (!input) return;
    const row = await deps.rules.update(owned.connection.id, owned.rule.id, owned.accountId, input);
    if (!row) {
      res.status(404).json({ error: "Rule not found." });
      return;
    }
    sendRule(res, row);
  });

  app.post("/account/connectors/:id/rules/:ruleId/enabled", async (req: AuthenticatedRequest, res) => {
    const owned = await ownedRule(req, res);
    if (!owned) return;
    const enabled = (req.body as Record<string, unknown> | undefined)?.enabled;
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be true or false." });
      return;
    }
    const row = await deps.rules.setEnabled(owned.connection.id, owned.rule.id, enabled);
    if (!row) {
      res.status(404).json({ error: "Rule not found." });
      return;
    }
    sendRule(res, row);
  });

  app.get("/account/connectors/:id/rules/:ruleId/versions", async (req: AuthenticatedRequest, res) => {
    const owned = await ownedRule(req, res);
    if (!owned) return;
    res.json({ versions: await deps.rules.versions(owned.rule.id) });
  });

  /** Rollback saves an earlier version's content as the newest version, so history only grows. */
  app.post("/account/connectors/:id/rules/:ruleId/rollback", async (req: AuthenticatedRequest, res) => {
    const owned = await ownedRule(req, res);
    if (!owned) return;
    const version = (req.body as Record<string, unknown> | undefined)?.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      res.status(400).json({ error: "Choose a version to roll back to." });
      return;
    }
    const target = await deps.rules.version(owned.rule.id, version);
    if (!target) {
      res.status(404).json({ error: "That version of the rule was not found." });
      return;
    }
    // The old content goes through today's validation and room check again.
    req.body = { name: target.name, room_id: target.room_id, trigger: target.trigger, actions: target.actions };
    const input = await parseBody(req, res, owned.connection.id);
    if (!input) return;
    const row = await deps.rules.update(owned.connection.id, owned.rule.id, owned.accountId, input);
    if (!row) {
      res.status(404).json({ error: "Rule not found." });
      return;
    }
    sendRule(res, row);
  });

  app.delete("/account/connectors/:id/rules/:ruleId", async (req: AuthenticatedRequest, res) => {
    const owned = await ownedRule(req, res);
    if (!owned) return;
    await deps.rules.delete(owned.connection.id, owned.rule.id);
    res.json({ deleted: true });
  });
}

import type { Express, Response } from "express";

import {
  TRACKER_RULES_PER_CONNECTION_MAX,
  type TrackerRuleList,
  type TrackerRuleView,
} from "../../../../../shared/ticket-connectors.mjs";
import { toTrackerRuleView, trackerRuleStore, type TrackerRuleRow, type TrackerRuleStore } from "../../../connectors/rules/store.js";
import { parseTrackerRuleInput } from "../../../connectors/rules/validate.js";
import { trackerConnectionStore, type TrackerConnectionRow, type TrackerConnectionStore } from "../../../connectors/store.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { requireAccount } from "./index.js";

export interface TrackerRuleRouteDeps {
  connections: Pick<TrackerConnectionStore, "get">;
  rules: Pick<TrackerRuleStore,
    "list" | "count" | "get" | "create" | "update" | "setEnabled" | "delete" | "versions" | "version" | "roomsForConnection">;
}

export function defaultTrackerRuleRouteDeps(): TrackerRuleRouteDeps {
  return { connections: trackerConnectionStore, rules: trackerRuleStore };
}

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
 * PR6 adds `POST /account/connectors/:id/rules/draft` (a sentence in, rule
 * JSON out for the editor) beside these routes; a draft is never saved here
 * without the person pressing Save, which sends it through the same
 * validation as any rule.
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
    const input = await parseBody(req, res, owned.connection.id);
    if (!input) return;
    if (await deps.rules.count(owned.connection.id) >= TRACKER_RULES_PER_CONNECTION_MAX) {
      res.status(400).json({ error: `A connection can have at most ${TRACKER_RULES_PER_CONNECTION_MAX} rules.` });
      return;
    }
    sendRule(res, await deps.rules.create(owned.connection.id, owned.accountId, input), 201);
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

import type { Express, Response } from "express";
import type { AuthenticatedRequest } from "../http/helpers.js";
import { requireAppSession } from "../request/app-session.js";
import { resolveRequestAuth } from "../request/auth.js";
import {
  conversationVersion,
  waitConversationChanges,
} from "../conversations/changes.js";
import {
  blockAccount,
  ConversationError,
  conversationMessages,
  createConversation,
  findConversationPeople,
  listConversations,
  sendConversationMessage,
  updateConversation,
} from "../conversations/store.js";

export function registerConversationRoutes(app: Express): void {
  const handle =
    (
      fn: (
        req: AuthenticatedRequest,
        res: Response,
        accountId: string,
      ) => Promise<void>,
    ) =>
    async (req: AuthenticatedRequest, res: Response) => {
      res.set("Cache-Control", "no-store");
      const accountId = requireAppSession(req, res);
      if (!accountId) return;
      try {
        await fn(req, res, accountId);
      } catch (error) {
        if (error instanceof ConversationError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        console.error("[conversations] request failed", error);
        if (!res.headersSent)
          res
            .status(500)
            .json({ error: "Couldn’t load your messages. Try again." });
      }
    };
  app.get(
    "/conversations",
    handle(async (_req, res, accountId) => {
      res.json(await listConversations(accountId));
    }),
  );
  app.get(
    "/conversations/people",
    handle(async (req, res, accountId) => {
      res.json(
        await findConversationPeople(accountId, String(req.query.q || "")),
      );
    }),
  );
  app.post(
    "/conversations",
    handle(async (req, res, accountId) => {
      if (
        req.body?.from_conversation_id !== undefined &&
        typeof req.body.from_conversation_id !== "string"
      )
        throw new ConversationError(400, "Invalid chat.");
      res
        .status(201)
        .json({
          conversation_id: await createConversation(
            accountId,
            req.body?.account_ids,
            req.body?.from_conversation_id,
          ),
        });
    }),
  );
  app.get(
    "/conversations/changes",
    handle(async (req, res, accountId) => {
      const after = String(req.query.after ?? "0");
      if (!/^\d{1,20}$/.test(after))
        throw new ConversationError(400, "Invalid message cursor.");
      const controller = new AbortController();
      const close = () => controller.abort();
      res.once("close", close);
      try {
        await waitConversationChanges(accountId, after, controller.signal);
        if (controller.signal.aborted) return;
        const fresh = await resolveRequestAuth(req);
        if (
          fresh.authKind !== "session" ||
          fresh.account?.account_id !== accountId
        ) {
          res.sendStatus(401);
          return;
        }
        res.json({ version: await conversationVersion(accountId) });
      } finally {
        res.off("close", close);
      }
    }),
  );
  app.get(
    "/conversations/:id/messages",
    handle(async (req, res, accountId) => {
      const before =
        req.query.before === undefined ? undefined : Number(req.query.before);
      const after =
        req.query.after === undefined ? undefined : Number(req.query.after);
      if (
        (before !== undefined && after !== undefined) ||
        [before, after].some(
          (value) =>
            value !== undefined && (!Number.isSafeInteger(value) || value < 0),
        )
      )
        throw new ConversationError(400, "Invalid message cursor.");
      res.json(
        await conversationMessages(accountId, String(req.params.id), {
          before,
          after,
        }),
      );
    }),
  );
  app.post(
    "/conversations/:id/messages",
    handle(async (req, res, accountId) => {
      res
        .status(201)
        .json(
          await sendConversationMessage(
            accountId,
            String(req.params.id),
            req.body?.text,
            req.body?.client_message_id,
          ),
        );
    }),
  );
  app.patch(
    "/conversations/:id",
    handle(async (req, res, accountId) => {
      await updateConversation(
        accountId,
        String(req.params.id),
        req.body ?? {},
      );
      res.json({ success: true });
    }),
  );
  app.put(
    "/conversations/blocks/:accountId",
    handle(async (req, res, accountId) => {
      if (typeof req.body?.blocked !== "boolean")
        throw new ConversationError(
          400,
          "Choose whether to block this person.",
        );
      await blockAccount(
        accountId,
        String(req.params.accountId),
        req.body.blocked,
      );
      res.json({ success: true });
    }),
  );
}

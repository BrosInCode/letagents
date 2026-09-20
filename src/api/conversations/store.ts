import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db/client.js";
import type {
  Conversation,
  ConversationList,
  ConversationMessage,
} from "../../../shared/conversation-contracts.mjs";

export class ConversationError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function participantIds(accountId: string, input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.some((id) => typeof id !== "string" || !/^[\w-]{1,100}$/.test(id))
  )
    throw new ConversationError(400, "Choose people to start a chat.");
  const ids = [...new Set([accountId, ...input])].sort();
  if (ids.length < 2 || ids.length > 100)
    throw new ConversationError(
      400,
      "Choose between 2 and 100 people for a chat.",
    );
  return ids;
}
async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function lockAccounts(client: PoolClient, ids: string[]) {
  const found = await client.query(
    "SELECT id FROM accounts WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE",
    [ids],
  );
  if (found.rowCount !== ids.length)
    throw new ConversationError(
      400,
      "One of these people is no longer available.",
    );
}
async function hasBlock(client: PoolClient, ids: string[]): Promise<boolean> {
  return Boolean(
    (
      await client.query(
        "SELECT 1 FROM account_blocks WHERE account_id=ANY($1::text[]) AND blocked_account_id=ANY($1::text[]) LIMIT 1",
        [ids],
      )
    ).rowCount,
  );
}
export async function invalidateConversations(
  client: PoolClient,
  ids: string[],
): Promise<void> {
  await client.query(
    `INSERT INTO conversation_versions (account_id, version)
    SELECT id,1 FROM unnest($1::text[]) id ORDER BY id
    ON CONFLICT (account_id) DO UPDATE SET version=conversation_versions.version+1`,
    [ids],
  );
  // Notifications are delivered only on commit and contain no message content.
  await client.query("SELECT pg_notify('conversation_changed', $1)", [
    JSON.stringify(ids),
  ]);
}
async function membership(
  client: PoolClient,
  accountId: string,
  id: string,
  write = false,
) {
  const own = await client.query(
    "SELECT * FROM conversation_members WHERE conversation_id=$1 AND account_id=$2",
    [id, accountId],
  );
  if (!own.rowCount)
    throw new ConversationError(404, "This chat is unavailable.");
  const members = await client.query(
    "SELECT account_id, accepted_at FROM conversation_members WHERE conversation_id=$1 ORDER BY account_id",
    [id],
  );
  const ids = members.rows.map((row) => row.account_id as string);
  if (write) await lockAccounts(client, ids);
  const conversation = await client.query(
    `SELECT * FROM conversations WHERE id=$1${write ? " FOR UPDATE" : ""}`,
    [id],
  );
  // Read membership again after obtaining write locks (accept/read can race).
  const current = write
    ? await client.query(
        "SELECT * FROM conversation_members WHERE conversation_id=$1 ORDER BY account_id",
        [id],
      )
    : members;
  return {
    own: write
      ? current.rows.find((row) => row.account_id === accountId)!
      : own.rows[0],
    members: current.rows,
    ids,
    conversation: conversation.rows[0],
  };
}

export async function createConversation(
  accountId: string,
  requested: unknown,
  fromId?: string,
): Promise<string> {
  return transaction(async (client) => {
    let ids = participantIds(accountId, requested);
    if (fromId) {
      const from = await membership(client, accountId, fromId);
      if (!from.own.accepted_at)
        throw new ConversationError(
          403,
          "Accept this chat before adding people.",
        );
      ids = participantIds(accountId, [...ids, ...from.ids]);
    }
    await lockAccounts(client, ids);
    if (await hasBlock(client, ids))
      throw new ConversationError(
        403,
        "A chat with these people is unavailable.",
      );
    const key = createHash("sha256").update(JSON.stringify(ids)).digest("hex");
    const existing = await client.query(
      "SELECT id FROM conversations WHERE participant_key=$1",
      [key],
    );
    if (existing.rowCount) {
      await client.query(
        "UPDATE conversation_members SET archived=false WHERE conversation_id=$1 AND account_id=$2",
        [existing.rows[0].id, accountId],
      );
      await invalidateConversations(client, [accountId]);
      return existing.rows[0].id;
    }
    const recent = await client.query(
      "SELECT count(*)::int AS count FROM conversations WHERE created_by=$1 AND created_at > now()-interval '1 hour'",
      [accountId],
    );
    if (recent.rows[0].count >= 30)
      throw new ConversationError(
        429,
        "You’ve started several chats. Try again later.",
      );
    const id = `chat_${randomUUID()}`;
    await client.query(
      "INSERT INTO conversations (id, participant_key, created_by) VALUES ($1,$2,$3)",
      [id, key, accountId],
    );
    await client.query(
      `INSERT INTO conversation_members (conversation_id,account_id,accepted_at)
      SELECT $1,id,CASE WHEN id=$2 THEN now() END FROM unnest($3::text[]) id`,
      [id, accountId, ids],
    );
    await invalidateConversations(client, ids);
    return id;
  });
}

export async function listConversations(
  accountId: string,
): Promise<ConversationList> {
  return transaction(async (client) => {
    await client.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const result = await client.query(
      `SELECT c.id,c.created_by,c.updated_at,
      own.accepted_at IS NOT NULL AS accepted, own.muted, own.archived,
      (SELECT count(*)::int FROM conversation_messages m WHERE m.conversation_id=c.id AND m.number>own.last_read_number AND m.sender_account_id<>$1) AS unread_count,
      COALESCE((SELECT json_agg(json_build_object('id',a.id,'login',a.login,'display_name',a.display_name,'avatar_url',a.avatar_url,
        'accepted',cm.accepted_at IS NOT NULL,'blocked',EXISTS(SELECT 1 FROM account_blocks b WHERE b.account_id=$1 AND b.blocked_account_id=a.id)) ORDER BY a.login)
        FROM conversation_members cm JOIN accounts a ON a.id=cm.account_id WHERE cm.conversation_id=c.id),'[]') AS members,
      (SELECT row_to_json(m) FROM conversation_messages m WHERE m.conversation_id=c.id AND m.number=c.last_message_number) AS last_message,
      (own.accepted_at IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM account_blocks b JOIN conversation_members x ON x.account_id=b.account_id AND x.conversation_id=c.id
        JOIN conversation_members y ON y.account_id=b.blocked_account_id AND y.conversation_id=c.id)
        AND (NOT EXISTS (SELECT 1 FROM conversation_members pending WHERE pending.conversation_id=c.id AND pending.accepted_at IS NULL)
        OR (c.created_by=$1 AND c.last_message_number=0))) AS can_send
      FROM conversation_members own JOIN conversations c ON c.id=own.conversation_id
      WHERE own.account_id=$1 ORDER BY c.updated_at DESC,c.id`,
      [accountId],
    );
    const version = await client.query(
      "SELECT version::text FROM conversation_versions WHERE account_id=$1",
      [accountId],
    );
    return {
      conversations: result.rows as Conversation[],
      version: version.rows[0]?.version ?? "0",
    };
  });
}

export async function conversationMessages(
  accountId: string,
  id: string,
  cursor: { before?: number; after?: number } = {},
) {
  return transaction(async (client) => {
    await membership(client, accountId, id);
    const forwards = cursor.after !== undefined;
    const rows = await client.query<ConversationMessage>(
      `SELECT * FROM conversation_messages WHERE conversation_id=$1
      AND ($2::int IS NULL OR number<$2) AND ($3::int IS NULL OR number>$3)
      ORDER BY number ${forwards ? "ASC" : "DESC"} LIMIT 101`,
      [id, cursor.before ?? null, cursor.after ?? null],
    );
    const messages = rows.rows.slice(0, 100);
    return {
      messages: forwards ? messages : messages.reverse(),
      has_more: rows.rows.length > 100,
    };
  });
}

export async function sendConversationMessage(
  accountId: string,
  id: string,
  text: unknown,
  clientId: unknown,
): Promise<ConversationMessage> {
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > 20000 ||
    typeof clientId !== "string" ||
    !/^[\w-]{8,100}$/.test(clientId)
  )
    throw new ConversationError(
      400,
      "Write a message of up to 20,000 characters.",
    );
  return transaction(async (client) => {
    const context = await membership(client, accountId, id, true);
    const existing = await client.query<ConversationMessage>(
      "SELECT * FROM conversation_messages WHERE conversation_id=$1 AND sender_account_id=$2 AND client_message_id=$3",
      [id, accountId, clientId],
    );
    if (existing.rowCount) {
      if (existing.rows[0].text !== text.trim())
        throw new ConversationError(
          409,
          "This send has already been used for another message.",
        );
      return existing.rows[0];
    }
    if (!context.own.accepted_at || (await hasBlock(client, context.ids)))
      throw new ConversationError(
        403,
        "You can’t send a message in this chat.",
      );
    if (
      context.members.some((member) => !member.accepted_at) &&
      !(
        context.conversation.created_by === accountId &&
        context.conversation.last_message_number === 0
      )
    )
      throw new ConversationError(
        403,
        "Wait for everyone to accept before sending another message.",
      );
    const updated = await client.query(
      "UPDATE conversations SET last_message_number=last_message_number+1,updated_at=now() WHERE id=$1 RETURNING last_message_number",
      [id],
    );
    const number = updated.rows[0].last_message_number;
    const message = await client.query<ConversationMessage>(
      "INSERT INTO conversation_messages (conversation_id,number,sender_account_id,client_message_id,text) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [id, number, accountId, clientId, text.trim()],
    );
    await client.query(
      "UPDATE conversation_members SET archived=false, last_read_number=CASE WHEN account_id=$2 THEN $3 ELSE last_read_number END WHERE conversation_id=$1",
      [id, accountId, number],
    );
    await client.query(
      `INSERT INTO desktop_push_notifications (
      id,device_id,conversation_id,message_number,room_display_name,sender,body,state,attempt_count,next_attempt_at,created_at,updated_at)
      SELECT 'dm_'||md5(d.id||$1||$3::text),d.id,$1,$3::integer,'Messages',COALESCE(a.display_name,a.login),
        CASE WHEN m.accepted_at IS NULL THEN 'Sent you a message request' ELSE 'Sent you a private message' END,
        'queued',0,now(),now(),now()
      FROM conversation_members m JOIN desktop_push_devices d ON d.account_id=m.account_id
      JOIN auth_sessions app ON app.id=d.app_session_id AND app.account_id=d.account_id AND app.expires_at>now()
      JOIN accounts a ON a.id=$2 WHERE m.conversation_id=$1 AND m.account_id<>$2 AND NOT m.muted AND d.enabled
      ON CONFLICT DO NOTHING`,
      [id, accountId, number],
    );
    await invalidateConversations(client, context.ids);
    return message.rows[0];
  });
}

export async function updateConversation(
  accountId: string,
  id: string,
  input: Record<string, unknown>,
) {
  if (
    Object.keys(input).some(
      (key) =>
        !["accept", "last_read_number", "muted", "archived"].includes(key),
    ) ||
    ["accept", "muted", "archived"].some(
      (key) => input[key] !== undefined && typeof input[key] !== "boolean",
    ) ||
    (input.last_read_number !== undefined &&
      (!Number.isSafeInteger(input.last_read_number) ||
        Number(input.last_read_number) < 0))
  )
    throw new ConversationError(400, "Invalid chat update.");
  return transaction(async (client) => {
    const context = await membership(client, accountId, id, true);
    if (input.accept && (await hasBlock(client, context.ids)))
      throw new ConversationError(403, "This chat is unavailable.");
    await client.query(
      `UPDATE conversation_members SET
      accepted_at=CASE WHEN $3 THEN COALESCE(accepted_at,now()) ELSE accepted_at END,
      last_read_number=GREATEST(last_read_number, LEAST(COALESCE($4,last_read_number),$7)),
      muted=COALESCE($5,muted),archived=COALESCE($6,archived)
      WHERE conversation_id=$1 AND account_id=$2`,
      [
        id,
        accountId,
        input.accept ?? false,
        input.last_read_number ?? null,
        input.muted ?? null,
        input.archived ?? null,
        context.conversation.last_message_number,
      ],
    );
    await invalidateConversations(
      client,
      input.accept ? context.ids : [accountId],
    );
  });
}

export async function blockAccount(
  accountId: string,
  target: string,
  blocked: boolean,
) {
  if (accountId === target)
    throw new ConversationError(400, "Choose another person.");
  await transaction(async (client) => {
    await lockAccounts(client, [accountId, target].sort());
    if (blocked)
      await client.query(
        "INSERT INTO account_blocks VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [accountId, target],
      );
    else
      await client.query(
        "DELETE FROM account_blocks WHERE account_id=$1 AND blocked_account_id=$2",
        [accountId, target],
      );
    const affected = await client.query(
      `SELECT DISTINCT m.account_id FROM conversation_members m
      WHERE m.conversation_id IN (SELECT x.conversation_id FROM conversation_members x JOIN conversation_members y USING (conversation_id) WHERE x.account_id=$1 AND y.account_id=$2) ORDER BY m.account_id`,
      [accountId, target],
    );
    await invalidateConversations(
      client,
      [
        ...new Set([
          accountId,
          target,
          ...affected.rows.map((row) => row.account_id),
        ]),
      ].sort(),
    );
  });
}

export async function findConversationPeople(accountId: string, query: string) {
  const term = query.trim();
  if (term.length < 2) return { people: [] };
  const result = await pool.query(
    `SELECT id,login,display_name,avatar_url FROM accounts a WHERE id<>$1
    AND (strpos(lower(login),lower($2))>0 OR strpos(lower(COALESCE(display_name,'')),lower($2))>0)
    AND NOT EXISTS (SELECT 1 FROM account_blocks WHERE account_id=$1 AND blocked_account_id=a.id)
    ORDER BY CASE WHEN lower(login)=lower($2) THEN 0 ELSE 1 END,login LIMIT 20`,
    [accountId, term.slice(0, 100)],
  );
  return { people: result.rows };
}

export async function canNotifyConversation(
  accountId: string,
  id: string,
  number: number,
  deviceId: string,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM conversation_members own WHERE own.conversation_id=$1 AND own.account_id=$2
    AND NOT own.muted AND NOT own.archived AND own.last_read_number<$3
    AND EXISTS (SELECT 1 FROM desktop_push_devices d JOIN auth_sessions s ON s.id=d.app_session_id WHERE d.id=$4 AND d.account_id=$2 AND s.account_id=$2 AND s.expires_at>now() AND d.enabled)
    AND NOT EXISTS (SELECT 1 FROM account_blocks b JOIN conversation_members x ON x.account_id=b.account_id AND x.conversation_id=$1
      JOIN conversation_members y ON y.account_id=b.blocked_account_id AND y.conversation_id=$1)`,
    [id, accountId, number, deviceId],
  );
  return Boolean(result.rowCount);
}

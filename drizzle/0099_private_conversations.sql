CREATE TABLE app_login_requests (
 id text PRIMARY KEY, secret_hash text NOT NULL, user_code text NOT NULL,
 consent_session_id text REFERENCES auth_sessions(id) ON DELETE CASCADE,
 consent_hash text, approved boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE conversations (
 id text PRIMARY KEY, participant_key text NOT NULL UNIQUE, created_by text NOT NULL REFERENCES accounts(id),
 last_message_number integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE conversation_members (
 conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 accepted_at timestamptz, last_read_number integer NOT NULL DEFAULT 0 CONSTRAINT conversation_members_read_check CHECK (last_read_number >= 0),
 muted boolean NOT NULL DEFAULT false, archived boolean NOT NULL DEFAULT false,
 PRIMARY KEY (conversation_id, account_id)
);
CREATE INDEX conversation_members_account_idx ON conversation_members(account_id, conversation_id);
CREATE TABLE conversation_messages (
 conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 number integer NOT NULL CONSTRAINT conversation_messages_number_check CHECK (number > 0), sender_account_id text NOT NULL REFERENCES accounts(id),
 client_message_id text NOT NULL, text text NOT NULL CONSTRAINT conversation_messages_text_check CHECK (length(text) BETWEEN 1 AND 20000),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (conversation_id, number),
 CONSTRAINT conversation_messages_retry_uq UNIQUE (conversation_id, sender_account_id, client_message_id),
 CONSTRAINT conversation_messages_sender_fk FOREIGN KEY (conversation_id, sender_account_id) REFERENCES conversation_members(conversation_id, account_id)
);
CREATE TABLE account_blocks (
 account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 blocked_account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 PRIMARY KEY (account_id, blocked_account_id), CONSTRAINT account_blocks_self_check CHECK (account_id <> blocked_account_id)
);
CREATE TABLE conversation_versions (
 account_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 version bigint NOT NULL DEFAULT 0
);
ALTER TABLE desktop_push_notifications ALTER COLUMN room_id DROP NOT NULL;
ALTER TABLE desktop_push_notifications ADD COLUMN conversation_id text REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE desktop_push_notifications ADD CONSTRAINT desktop_push_notifications_target_check CHECK ((room_id IS NULL) <> (conversation_id IS NULL));
ALTER TABLE desktop_push_notifications ADD CONSTRAINT desktop_push_notifications_conversation_message_fk FOREIGN KEY (conversation_id,message_number) REFERENCES conversation_messages(conversation_id,number) ON DELETE CASCADE;
CREATE UNIQUE INDEX desktop_push_notifications_conversation_uq ON desktop_push_notifications(device_id,conversation_id,message_number) WHERE conversation_id IS NOT NULL;
ALTER TABLE desktop_push_devices ADD COLUMN app_session_id text REFERENCES auth_sessions(id) ON DELETE SET NULL;

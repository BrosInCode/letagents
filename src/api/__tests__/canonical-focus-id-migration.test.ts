import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { Pool } from "pg";

const testDatabaseUrl = process.env.TEST_DB_URL;

test(
  "canonical focus migration preserves projected agent messages across room-id cascades",
  { skip: testDatabaseUrl ? false : "set TEST_DB_URL to run DB-backed migration tests" },
  async () => {
    const pool = new Pool({ connectionString: testDatabaseUrl });
    const legacyRoomId = "git-room:github.com:brosincode/letagents:branch:bWFzdGVy";

    try {
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await pool.query(`
        CREATE TABLE rooms (
          id text PRIMARY KEY,
          kind text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE id_sequences (name text PRIMARY KEY, value integer NOT NULL);
        CREATE TABLE rental_sessions (
          id text PRIMARY KEY,
          target_room_id text,
          room_id text,
          CONSTRAINT rental_sessions_target_room_fk
            FOREIGN KEY (target_room_id) REFERENCES rooms(id),
          CONSTRAINT rental_sessions_room_fk
            FOREIGN KEY (room_id) REFERENCES rooms(id)
        );
        CREATE TABLE rental_activity_events (
          id text PRIMARY KEY,
          room_id text,
          CONSTRAINT rental_activity_events_room_fk
            FOREIGN KEY (room_id) REFERENCES rooms(id)
        );
        CREATE TABLE github_app_repositories (room_id text);
        CREATE TABLE github_webhook_deliveries (room_id text);
        CREATE TABLE message_agent_receipt_events (message_room_id text);
        CREATE TABLE supervisor_host_grants (allowed_room_ids text[] NOT NULL);

        CREATE TABLE messages (
          room_id text NOT NULL,
          number integer NOT NULL,
          PRIMARY KEY (room_id, number),
          FOREIGN KEY (room_id) REFERENCES rooms(id) ON UPDATE CASCADE
        );
        CREATE TABLE message_thread_participants (
          room_id text NOT NULL,
          thread_root_number integer NOT NULL,
          participant_number integer NOT NULL,
          PRIMARY KEY (room_id, thread_root_number, participant_number),
          FOREIGN KEY (room_id, thread_root_number)
            REFERENCES messages(room_id, number) ON UPDATE CASCADE
        );
        CREATE TABLE message_thread_participant_agents (
          room_id text NOT NULL,
          thread_root_number integer NOT NULL,
          participant_number integer NOT NULL,
          agent_number integer NOT NULL,
          PRIMARY KEY (room_id, thread_root_number, participant_number, agent_number),
          CONSTRAINT message_thread_participant_agents_participant_fk
            FOREIGN KEY (room_id, thread_root_number, participant_number)
            REFERENCES message_thread_participants(room_id, thread_root_number, participant_number)
            ON UPDATE CASCADE
        );
        CREATE TABLE message_thread_projected_messages (
          room_id text NOT NULL,
          message_number integer NOT NULL,
          thread_root_number integer NOT NULL,
          participant_number integer NOT NULL,
          participant_agent_number integer,
          PRIMARY KEY (room_id, message_number),
          CONSTRAINT message_thread_projected_messages_message_fk
            FOREIGN KEY (room_id, message_number)
            REFERENCES messages(room_id, number) ON UPDATE CASCADE,
          CONSTRAINT message_thread_projected_messages_root_fk
            FOREIGN KEY (room_id, thread_root_number)
            REFERENCES messages(room_id, number) ON UPDATE CASCADE,
          CONSTRAINT message_thread_projected_messages_participant_agent_fk
            FOREIGN KEY (room_id, thread_root_number, participant_number, participant_agent_number)
            REFERENCES message_thread_participant_agents(
              room_id, thread_root_number, participant_number, agent_number
            ) ON UPDATE CASCADE
        );
      `);

      await pool.query(
        `INSERT INTO rooms (id, kind) VALUES ($1, 'focus')`,
        [legacyRoomId],
      );
      await pool.query(
        `INSERT INTO id_sequences (name, value) VALUES
          ('focus_rooms', 64),
          ('messages:' || $1, 2),
          ('tasks:' || $1, 1)`,
        [legacyRoomId],
      );
      await pool.query(
        `INSERT INTO messages (room_id, number) VALUES ($1, 1), ($1, 2)`,
        [legacyRoomId],
      );
      await pool.query(
        `INSERT INTO message_thread_participants
          (room_id, thread_root_number, participant_number)
         VALUES ($1, 1, 1)`,
        [legacyRoomId],
      );
      await pool.query(
        `INSERT INTO message_thread_participant_agents
          (room_id, thread_root_number, participant_number, agent_number)
         VALUES ($1, 1, 1, 1)`,
        [legacyRoomId],
      );
      await pool.query(
        `INSERT INTO message_thread_projected_messages
          (room_id, message_number, thread_root_number, participant_number, participant_agent_number)
         VALUES ($1, 2, 1, 1, 1)`,
        [legacyRoomId],
      );

      const migration = await readFile(
        path.resolve(process.cwd(), "drizzle/0084_canonical_focus_room_ids.sql"),
        "utf8",
      );
      const statements = migration
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const statement of statements) await client.query(statement);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      const canonicalRoomId = "focus_65";
      const migrated = await pool.query(
        `SELECT
          (SELECT id FROM rooms) AS room_id,
          (SELECT room_id FROM messages WHERE number = 2) AS message_room_id,
          (SELECT room_id FROM message_thread_participant_agents) AS agent_room_id,
          (SELECT room_id FROM message_thread_projected_messages) AS projected_room_id,
          (SELECT value FROM id_sequences WHERE name = 'focus_rooms') AS focus_high_water,
          EXISTS (
            SELECT 1 FROM id_sequences WHERE name = 'messages:' || $1
          ) AS message_counter_moved,
          EXISTS (
            SELECT 1 FROM id_sequences WHERE name = 'tasks:' || $1
          ) AS task_counter_moved`,
        [canonicalRoomId],
      );
      assert.deepEqual(migrated.rows[0], {
        room_id: canonicalRoomId,
        message_room_id: canonicalRoomId,
        agent_room_id: canonicalRoomId,
        projected_room_id: canonicalRoomId,
        focus_high_water: 65,
        message_counter_moved: true,
        task_counter_moved: true,
      });

      const constraint = await pool.query(
        `SELECT condeferrable, condeferred
           FROM pg_constraint
          WHERE conname = 'message_thread_projected_messages_participant_agent_fk'`,
      );
      assert.deepEqual(constraint.rows[0], { condeferrable: false, condeferred: false });
    } finally {
      await pool.end();
    }
  },
);

import { createHash, randomUUID } from "node:crypto";
import { and, eq, ne, or, sql } from "drizzle-orm";
import type { Express } from "express";

import { db } from "../db/client.js";
import { desktop_push_devices } from "../db/schema.js";
import type { AuthenticatedRequest } from "../http/helpers.js";
import { resolveRequestAuth } from "../request/auth.js";
import { respondWithInternalError } from "../http/helpers.js";

const DESKTOP_BUNDLE_ID = "chat.letagents.desktop";
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const DEVICE_TOKEN_PATTERN = /^[A-Fa-f0-9]{64,512}$/;

function normalizeString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

export function registerDesktopPushRoutes(app: Express): void {
  app.post("/desktop/push/devices", async (req: AuthenticatedRequest, res) => {
    try {
      const auth = await resolveRequestAuth(req);
      if (!auth.account) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const installationId = normalizeString(req.body?.installation_id, 128);
      const rawDeviceToken = normalizeString(req.body?.device_token, 512);
      const deviceToken = rawDeviceToken?.replace(/[<>\s]/g, "") || null;
      const bundleId = normalizeString(req.body?.bundle_id, 128);
      const environment = normalizeString(req.body?.environment, 16);
      const appVersion = normalizeString(req.body?.app_version, 64);

      if (!installationId || !INSTALLATION_ID_PATTERN.test(installationId)) {
        res.status(400).json({ error: "installation_id is invalid" });
        return;
      }
      if (!deviceToken || !DEVICE_TOKEN_PATTERN.test(deviceToken)) {
        res.status(400).json({ error: "device_token is invalid" });
        return;
      }
      if (bundleId !== DESKTOP_BUNDLE_ID) {
        res.status(400).json({ error: "bundle_id is invalid" });
        return;
      }
      if (environment !== "production" && environment !== "sandbox") {
        res.status(400).json({ error: "environment is invalid" });
        return;
      }

      const now = new Date().toISOString();
      const accountId = auth.account.account_id;
      const tokenHash = createHash("sha256").update(deviceToken.toLowerCase()).digest("hex");
      const device = await db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${environment}:${tokenHash}`}::text, 0::bigint)
          )
        `);
        await tx.delete(desktop_push_devices).where(and(
          eq(desktop_push_devices.environment, environment),
          eq(desktop_push_devices.token_hash, tokenHash),
          or(
            ne(desktop_push_devices.account_id, accountId),
            ne(desktop_push_devices.installation_id, installationId),
          ),
        ));
        const [registered] = await tx
          .insert(desktop_push_devices)
          .values({
            id: randomUUID(),
            account_id: accountId,
            installation_id: installationId,
            device_token: deviceToken.toLowerCase(),
            token_hash: tokenHash,
            bundle_id: bundleId,
            environment,
            app_version: appVersion,
            enabled: true,
            failure_count: 0,
            last_error: null,
            last_registered_at: now,
            disabled_at: null,
            created_at: now,
            updated_at: now,
          })
          .onConflictDoUpdate({
            target: [
              desktop_push_devices.account_id,
              desktop_push_devices.installation_id,
              desktop_push_devices.environment,
            ],
            set: {
              device_token: deviceToken.toLowerCase(),
              token_hash: tokenHash,
              bundle_id: bundleId,
              app_version: appVersion,
              enabled: true,
              failure_count: 0,
              last_error: null,
              last_registered_at: now,
              disabled_at: null,
              updated_at: now,
            },
          })
          .returning({ id: desktop_push_devices.id });
        await tx.execute(sql`
          DELETE FROM desktop_push_devices
          WHERE account_id = ${accountId}
            AND id NOT IN (
              SELECT id
              FROM desktop_push_devices
              WHERE account_id = ${accountId}
              ORDER BY CASE WHEN id = ${registered.id} THEN 0 ELSE 1 END,
                       last_registered_at DESC
              LIMIT 25
            )
        `);
        return registered;
      });

      res.status(200).json({ device_id: device.id, enabled: true });
    } catch (error) {
      respondWithInternalError(res, "desktop-push-register", error, "Could not register this desktop for notifications");
    }
  });

  app.delete("/desktop/push/devices/:installationId", async (req: AuthenticatedRequest, res) => {
    try {
      const auth = await resolveRequestAuth(req);
      if (!auth.account) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const installationId = normalizeString(req.params.installationId, 128);
      if (!installationId || !INSTALLATION_ID_PATTERN.test(installationId)) {
        res.status(400).json({ error: "installation_id is invalid" });
        return;
      }
      await db.delete(desktop_push_devices).where(and(
        eq(desktop_push_devices.account_id, auth.account.account_id),
        eq(desktop_push_devices.installation_id, installationId),
      ));
      res.status(204).end();
    } catch (error) {
      respondWithInternalError(res, "desktop-push-delete", error, "Could not unregister this desktop");
    }
  });
}

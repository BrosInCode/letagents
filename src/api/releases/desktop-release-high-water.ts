import type { Pool } from "pg";

interface VersionParts {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(version: string): VersionParts {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid desktop version ${version}.`);
  const [major, minor, patch] = version.split(".").map(Number);
  return { major, minor, patch };
}

export async function advanceDesktopReleaseHighWater(
  version: string,
  database?: Pick<Pool, "query">,
): Promise<void> {
  database ??= (await import("../db/client.js")).pool;
  const { major, minor, patch } = parseVersion(version);
  const result = await database.query<{
    accepted: boolean;
    major: number;
    minor: number;
    patch: number;
  }>(`
    WITH advanced AS (
      INSERT INTO desktop_release_high_water (channel, major, minor, patch, updated_at)
      VALUES ('mac-beta', $1, $2, $3, now())
      ON CONFLICT (channel) DO UPDATE SET
        major = EXCLUDED.major,
        minor = EXCLUDED.minor,
        patch = EXCLUDED.patch,
        updated_at = now()
      WHERE (desktop_release_high_water.major, desktop_release_high_water.minor, desktop_release_high_water.patch)
         < (EXCLUDED.major, EXCLUDED.minor, EXCLUDED.patch)
      RETURNING true AS accepted, major, minor, patch
    )
    SELECT accepted, major, minor, patch FROM advanced
    UNION ALL
    SELECT
      (major, minor, patch) <= ($1::integer, $2::integer, $3::integer) AS accepted,
      major,
      minor,
      patch
    FROM desktop_release_high_water
    WHERE channel = 'mac-beta' AND NOT EXISTS (SELECT 1 FROM advanced)
    LIMIT 1
  `, [major, minor, patch]);
  const highWater = result.rows[0];
  if (highWater?.accepted) return;
  const highWaterVersion = highWater
    ? `${highWater.major}.${highWater.minor}.${highWater.patch}`
    : "a newer release";
  throw new Error(`Desktop release manifest ${version} is older than durable high-water ${highWaterVersion}.`);
}

export async function canUseBundledDesktopReleaseFallback(
  bundledVersion: string,
  database?: Pick<Pool, "query">,
): Promise<boolean> {
  database ??= (await import("../db/client.js")).pool;
  const { major, minor, patch } = parseVersion(bundledVersion);
  const result = await database.query<{ allowed: boolean }>(`
    SELECT (major, minor, patch) <= ($1::integer, $2::integer, $3::integer) AS allowed
    FROM desktop_release_high_water
    WHERE channel = 'mac-beta'
  `, [major, minor, patch]);
  return result.rows[0]?.allowed === true;
}

export async function assertDesktopReleaseAtOrAboveHighWater(
  version: string,
  database?: Pick<Pool, "query">,
): Promise<void> {
  if (!await canUseBundledDesktopReleaseFallback(version, database)) {
    throw new Error(`Desktop release manifest ${version} is older than durable high-water.`);
  }
}

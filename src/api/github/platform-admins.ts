/**
 * Server admins are the GitHub logins named in `LETAGENTS_PLATFORM_ADMINS`
 * (comma separated, case-insensitive, an optional leading `@` is ignored).
 *
 * The check fails closed: when the list is unset or empty, nobody is a server
 * admin. A room admin is never a server admin by default, because anyone can
 * be the admin of a room they create.
 */
export function parsePlatformAdminLogins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => normalizeLogin(entry))
    .filter((entry): entry is string => entry !== null);
}

export function hasPlatformAdmins(env: NodeJS.ProcessEnv = process.env): boolean {
  return parsePlatformAdminLogins(env.LETAGENTS_PLATFORM_ADMINS).length > 0;
}

export function isPlatformAdminLogin(
  login: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const normalized = normalizeLogin(login);
  if (!normalized) return false;
  return parsePlatformAdminLogins(env.LETAGENTS_PLATFORM_ADMINS).includes(normalized);
}

function normalizeLogin(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/^@/, "").trim().toLowerCase();
  return trimmed ? trimmed : null;
}

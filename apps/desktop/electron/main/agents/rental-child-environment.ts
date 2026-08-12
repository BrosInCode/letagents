const RENTAL_MARKER = "LETAGENTS_RENTAL_CREDENTIAL_ISOLATION";

const SAFE_KEYS = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
  "TERM", "TMPDIR", "TMP", "TEMP", "NO_COLOR", "FORCE_COLOR",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
]);

/**
 * Defense in depth for rental-capable provider children: strip ambient token
 * values. Filesystem isolation is enforced separately by the verified rental
 * permission profile; this helper does not claim that HOME is a sandbox.
 */
export function rentalIsolatedChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || key === RENTAL_MARKER) continue;
    if (SAFE_KEYS.has(key)
      || key.startsWith("LETAGENTS_SUPERVISOR_")
      || key === "LETAGENTS_SUPERVISED_BOUNDED_TURNS"
      || key === "LETAGENTS_EXECUTION_PROFILE"
      || key === "LETAGENTS_PERMISSION_PROFILE_ID") {
      environment[key] = value;
    }
  }
  return environment;
}

export function isRentalCredentialIsolationRequested(environment: NodeJS.ProcessEnv): boolean {
  return environment[RENTAL_MARKER] === "1";
}

export const rentalCredentialIsolationMarker = RENTAL_MARKER;

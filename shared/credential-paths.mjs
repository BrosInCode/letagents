/**
 * File names and folders that may hold credentials or an agent tool's private
 * configuration. The desktop daemon and the MCP server read files with the
 * owner's rights, outside an agent's sandbox, so they never attach these, and
 * a permission review never projects them. Both import this one list.
 */

/** Security invariant shared by execution-approval projection production and persistence. */
export function executionApprovalProjectionPathsAreSafe(paths) {
  const occupied = [];
  const caseInsensitive = new Intl.Collator("und", { usage: "search", sensitivity: "base" });
  return paths.every((path) => {
    if (occupied.some(candidate => caseInsensitive.compare(candidate, path) === 0)) return false;
    occupied.push(path);
    // A file system can read other characters as these ones: macOS opens
    // `.ssh` for a name written with a long s. Compare what it would open.
    const parts = path.normalize("NFKC").toLowerCase().toUpperCase().toLowerCase().split("/");
    const name = parts.at(-1);
    return !parts.some((part) => [".git", ".ssh", ".gnupg", ".aws", ".kube", "secrets", "credentials"].includes(part))
      && name !== ".env" && !name.startsWith(".env.")
      && ![".npmrc", ".pypirc", ".netrc", ".git-credentials", "credentials.json", "service-account.json",
        "id_rsa", "id_ed25519", "authorized_keys"].includes(name)
      && !/\.(?:pem|key|p12|pfx|jks|keystore)$/.test(name)
      && !(parts.at(-2) === ".docker" && name === "config.json")
      && !(parts.at(-2) === "gcloud" && name === "application_default_credentials.json");
  });
}

/** Folder names that hold credentials or an agent tool's private configuration, wherever they are. */
export const CREDENTIAL_FOLDER_NAMES = new Set([
  ".git", ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".terraform",
  ".codex", ".claude", ".cursor", ".letagents", ".vscode", ".idea", "secrets", "credentials",
]);
const SECRET_NAMES = [
  /^\.env/, /^\.dev\.vars/, /^\.letagents/, /^\.mcp\.json$/,
  /^\.(npmrc|netrc|pypirc|pgpass|git-credentials|htpasswd|vault-token|yarnrc\.yml)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)/, /^authorized_keys$/, /^known_hosts$/, /^kubeconfig/,
  /\.(pem|key|p8|p12|pfx|ppk|jks|keystore|kdbx|tfvars|tfstate)(\.|$)/, /^terraform\.tfstate/,
  /^(auth|credentials?|secrets?)(\.(json|ya?ml|toml|ini|txt|env|xml|cfg|conf|enc|properties))*$/,
  /service[-_]?account.*\.json$/, /^firebase-adminsdk.*\.json$/,
  /^\.credentials\.json$/, /^mcp-state\.json/, /^client_secret.*\.json$/, /^token\.json$/, /^credentials\.db$/,
  /\.keychain(-db)?$/,
];

/**
 * Whether a path inside a workspace, split into its parts, may hold
 * credentials. Workspace containment is the main control; this list and the
 * approval-projection list are defence in depth.
 */
export function workspacePathMayHoldCredentials(parts) {
  // Compare what the file system would open: macOS reads a long s as an s, and ignores case.
  const folded = parts.map((part) => part.normalize("NFKC").toLowerCase());
  const name = folded.at(-1) ?? "";
  return folded.some((part) => CREDENTIAL_FOLDER_NAMES.has(part))
    || SECRET_NAMES.some((rule) => rule.test(name))
    || !executionApprovalProjectionPathsAreSafe([folded.join("/")]);
}

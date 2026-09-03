/** Security invariant shared by projection production and persistence. */
export function executionApprovalProjectionPathsAreSafe(paths: readonly string[]): boolean {
  const occupied: string[] = [];
  const caseInsensitive = new Intl.Collator("und", { usage: "search", sensitivity: "base" });
  return paths.every((path) => {
    if (occupied.some(candidate => caseInsensitive.compare(candidate, path) === 0)) return false;
    occupied.push(path);
    const parts = path.toLowerCase().split("/");
    const name = parts.at(-1)!;
    return !parts.some((part) => [".git", ".ssh", ".gnupg", ".aws", ".kube", "secrets", "credentials"].includes(part))
      && name !== ".env" && !name.startsWith(".env.")
      && ![".npmrc", ".pypirc", ".netrc", ".git-credentials", "credentials.json", "service-account.json",
        "id_rsa", "id_ed25519", "authorized_keys"].includes(name)
      && !/\.(?:pem|key|p12|pfx|jks|keystore)$/.test(name)
      && !(parts.at(-2) === ".docker" && name === "config.json")
      && !(parts.at(-2) === "gcloud" && name === "application_default_credentials.json");
  });
}

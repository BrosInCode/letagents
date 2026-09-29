export type BearerAuthorization =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "token"; token: string };

/** Keep authentication, cookie protection and revocation on one interpretation. */
export function parseBearerAuthorization(header: string | undefined): BearerAuthorization {
  if (!/^Bearer(?:\s|$)/i.test(header ?? "")) return { kind: "none" };
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header!);
  return match ? { kind: "token", token: match[1] } : { kind: "invalid" };
}

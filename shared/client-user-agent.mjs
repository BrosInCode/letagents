/**
 * The User-Agent a LetAgents client sends to the room server.
 *
 * Node's fetch sends `node` for every client that does not choose one, so the
 * server's logs could not tell the desktop app, its daemon and the MCP client
 * apart, nor one build from the next. Example of what this builds:
 *
 *   LetAgents-Desktop/0.1.140 (darwin; arm64)
 *
 * Only letters, digits and `._+-` are kept in each part: a header value must
 * not carry spaces from a version string or anything a log parser could
 * misread. A missing version becomes `0`.
 */
export function letagentsUserAgent(product, version, platform = process.platform, arch = process.arch) {
  const part = (value, fallback) => String(value ?? "").replace(/[^A-Za-z0-9._+-]/g, "") || fallback;
  return `LetAgents-${part(product, "Client")}/${part(version, "0")} (${part(platform, "unknown")}; ${part(arch, "unknown")})`;
}

/**
 * The same request headers with `User-Agent` added, unless the caller already
 * chose one. The headers keep their shape (a `Headers` object, a list of pairs
 * or a plain object), and the input is not changed.
 */
export function withUserAgent(headers, userAgent) {
  if (headers instanceof Headers) {
    if (headers.has("user-agent")) return headers;
    const copy = new Headers(headers);
    copy.set("User-Agent", userAgent);
    return copy;
  }
  if (Array.isArray(headers)) {
    return headers.some(([name]) => String(name).toLowerCase() === "user-agent")
      ? headers
      : [...headers, ["User-Agent", userAgent]];
  }
  const plain = headers ?? {};
  return Object.keys(plain).some((name) => name.toLowerCase() === "user-agent")
    ? plain
    : { ...plain, "User-Agent": userAgent };
}

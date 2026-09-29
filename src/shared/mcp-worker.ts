/** Durable worker identity is separate from the random MCP process identity. */
export function isMcpWorkerId(value: unknown): value is string {
  return typeof value === "string" && /^worker_[a-f0-9]{32}$/.test(value);
}

export function isMcpConnectionToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** `LetAgents-<product>/<version> (<platform>; <arch>)`, for example `LetAgents-Desktop/0.1.140 (darwin; arm64)`. */
export function letagentsUserAgent(product: string, version: string | null | undefined, platform?: string, arch?: string): string;
/** The same headers, in the same shape, with `User-Agent` added unless one is already there. */
export function withUserAgent(headers: HeadersInit | undefined, userAgent: string): HeadersInit;

/**
 * The public origin of this LetAgents server, for every link a wake delivery
 * carries (the room page, the email confirmation and stop links). The API
 * also serves the web app, so one origin serves both. An empty setting counts
 * as unset.
 */
const DEFAULT_BASE_URL = "https://letagents.chat";

export function letAgentsPublicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.LETAGENTS_BASE_URL?.trim() || env.PUBLIC_API_URL?.trim() || env.LETAGENTS_PUBLIC_URL?.trim();
  return (configured || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** Every host name this server is reached at publicly. A webhook may never point at one of them, or at a name under one. */
export function letAgentsPublicHostnames(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const hosts = new Set<string>();
  for (const value of [env.LETAGENTS_BASE_URL, env.PUBLIC_API_URL, env.LETAGENTS_PUBLIC_URL, DEFAULT_BASE_URL]) {
    if (!value?.trim()) continue;
    try {
      hosts.add(new URL(value.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, ""));
    } catch {
      // A malformed setting names no host.
    }
  }
  return hosts;
}

/** The room's page in the web app. */
export function wakeRoomUrl(roomId: string, baseUrl = letAgentsPublicBaseUrl()): string {
  return `${baseUrl.replace(/\/+$/, "")}/in/${roomId.split("/").map(encodeURIComponent).join("/")}`;
}

/** A confirmation or stop link of an email rule. */
export function wakeLinkUrl(kind: "confirm" | "disable", token: string, baseUrl = letAgentsPublicBaseUrl()): string {
  return `${baseUrl.replace(/\/+$/, "")}/wake-rules/${kind}/${token}`;
}

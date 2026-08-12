import type { ApnsSendResult } from "./apns-client.js";

export type ApnsDisposition = "delivered" | "retry" | "dead" | "disable-device";

export function classifyApnsResult(result: ApnsSendResult): ApnsDisposition {
  if (result.status === 200) return "delivered";
  if (
    result.status === 410
    || result.reason === "BadDeviceToken"
    || result.reason === "DeviceTokenNotForTopic"
    || result.reason === "Unregistered"
  ) return "disable-device";
  // APNs uses 403 for provider-token failures such as ExpiredProviderToken.
  // Retrying lets the worker mint a fresh provider JWT, while MAX_ATTEMPTS still
  // bounds persistent credential or clock configuration failures.
  if (result.status === 0 || result.status === 403 || result.status === 429 || result.status >= 500) return "retry";
  return "dead";
}

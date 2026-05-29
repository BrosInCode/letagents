export function toGitHubId(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

export function normalizeDeliveryId(deliveryId: string | null | undefined): string | null {
  return toGitHubId(deliveryId);
}

export function buildDeliveryScopedKey(baseKey: string, deliveryId: string): string {
  return `${baseKey}:delivery:${deliveryId}`;
}

export function getRepoIdentity(fullName: string): string {
  return fullName.trim().toLowerCase();
}

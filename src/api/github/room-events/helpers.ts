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

export function normalizeGitHubTimestamp(value: string | null | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

export function isZeroSha(value: string | null | undefined): boolean {
  return Boolean(value && /^0+$/.test(value.trim()));
}

export function normalizeGitRef(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function branchNameFromGitRef(value: string | null | undefined): string | null {
  const normalized = normalizeGitRef(value);
  if (!normalized) {
    return null;
  }

  return normalized.startsWith("refs/heads/")
    ? normalized.slice("refs/heads/".length)
    : normalized;
}

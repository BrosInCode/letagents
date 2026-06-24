import { readStoredAuth } from "../../auth.js";
import { readLocalProfileId } from "../../chat-storage/settings.js";

type StoredAuth = Awaited<ReturnType<typeof readStoredAuth>>;

export async function resolveLocalThreadReaderKey(
  storedAuth?: StoredAuth,
): Promise<string> {
  const auth = storedAuth ?? await readStoredAuth();
  if (auth.account?.id) return `account:${auth.account.id}`;
  return `local:${await readLocalProfileId()}`;
}

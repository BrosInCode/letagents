export interface PersonTarget {
  /** GitHub login as the server reports it (room participant githubLogin / message sender login). */
  login: string;
  displayName: string;
  avatarUrl: string | null;
}
export function personTargetKey(target: PersonTarget): string {
  return `person:${target.login.toLowerCase()}`;
}

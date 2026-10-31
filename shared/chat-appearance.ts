/** Viewer-relative presentation. Display names are not account identities. */
export function chatSenderRole(input: {
  human: boolean; agent: boolean; login?: string | null; agentKey?: string | null;
  viewerLogin?: string | null; outgoing?: boolean;
}): 'self' | 'human' | 'own-agent' | 'other-agent' | null {
  const viewer = input.viewerLogin?.trim().toLowerCase();
  if (input.agent) {
    const key = input.agentKey?.split('/');
    const owner = key?.length === 2 ? key[0] : key?.length === 4 && key[0] === 'local' ? key[1] : null;
    return viewer && owner?.toLowerCase() === viewer ? 'own-agent' : 'other-agent';
  }
  if (input.human) return input.outgoing || (viewer && input.login?.toLowerCase() === viewer) ? 'self' : 'human';
  return null;
}

export function avatarInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words.at(-1)![0]}` : (words[0] || '?').slice(0, 2)).toUpperCase();
}

import { ref } from 'vue';

export type ReaderTextSize = 'small' | 'default' | 'large';
export interface MessageReaderSender {
  name: string;
  context?: string | null;
  timestamp?: string | null;
  avatarUrl?: string | null;
  agent?: boolean;
  provider?: string | null;
  agentKey?: string | null;
}

// A reading preference for this app session, shared across messages. Hover never writes it.
export const selectedReaderTextSize = ref<ReaderTextSize>('default');

export interface ReadingPosition {
  scrollTop: number;
  range?: Range;
  offset?: number;
}

export function captureReadingPosition(content: HTMLElement, scroll: HTMLElement): ReadingPosition {
  const position: ReadingPosition = { scrollTop: scroll.scrollTop };
  if (scroll.scrollTop === 0) return position;
  const top = scroll.getBoundingClientRect().top;
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    if (range.getBoundingClientRect().bottom <= top) continue;
    let low = 0;
    let high = node.textContent.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      range.setStart(node, mid);
      range.setEnd(node, mid + 1);
      if (range.getBoundingClientRect().bottom <= top) low = mid + 1;
      else high = mid;
    }
    range.setStart(node, low);
    range.setEnd(node, low + 1);
    return { ...position, range, offset: range.getBoundingClientRect().top - top };
  }
  return position;
}

export function restoreReadingPosition(scroll: HTMLElement, position: ReadingPosition, exact = false): void {
  if (exact || !position.range || !position.range.startContainer.isConnected) {
    scroll.scrollTop = position.scrollTop;
    return;
  }
  scroll.scrollTop += position.range.getBoundingClientRect().top - scroll.getBoundingClientRect().top - (position.offset ?? 0);
}

// Pure builder for the chat-message context menu item ids, kept out of the
// component so the grouping (a link group only when a web link was
// right-clicked, plus the always-present message group) can be unit-tested.
// The component maps these ids to icons and handlers.

export type MessageContextMenuActionId =
  | "open-link"
  | "copy-link"
  | "copy-message"
  | "quote-reply"
  | "reply-in-thread";

export type MessageContextMenuItem = {
  id: MessageContextMenuActionId;
  label: string;
};

export function buildMessageContextMenuGroups(linkHref: string | null): MessageContextMenuItem[][] {
  const groups: MessageContextMenuItem[][] = [];
  if (linkHref) {
    groups.push([
      { id: "open-link", label: "Open link in browser" },
      { id: "copy-link", label: "Copy link" },
    ]);
  }
  groups.push([
    { id: "copy-message", label: "Copy message" },
    { id: "quote-reply", label: "Quote reply" },
    { id: "reply-in-thread", label: "Reply in thread" },
  ]);
  return groups;
}

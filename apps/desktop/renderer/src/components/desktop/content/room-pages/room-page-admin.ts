import { ref, type InjectionKey } from "vue";
import { CAPABILITIES } from "../../../../../../../../shared/api/capabilities.mjs";
import type { DesktopRoomPageDetail } from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc";
import { requestRoomPagesRefresh } from "./useRoomPages";

/** One line of the grant sheet: what the page asks for, in the registry's plain words. */
export interface PageGrantRow {
  name: string;
  label: string;
  /** A page cannot hold it (room administration), or the app does not know it yet. */
  grantable: boolean;
  /** What happens when the page uses it, before any room setting changes it. */
  note: string | null;
}

export function pageGrantRows(capabilities: readonly string[]): PageGrantRow[] {
  return capabilities.map((name) => {
    const spec = Object.hasOwn(CAPABILITIES, name) ? CAPABILITIES[name as keyof typeof CAPABILITIES] : null;
    if (!spec) return { name, label: name, grantable: false, note: "Unknown to this version of the app" };
    const note = spec.defaultPolicy === "confirm"
      ? "Asks the person each time"
      : spec.defaultPolicy === "approve" ? "Waits for a room admin unless the room allows it" : null;
    return { name, label: spec.label, grantable: spec.grantable, note };
  });
}

/** The newest version of a page that waits for a room admin, if it is newer than the live one. */
export function pendingPageVersion(detail: DesktopRoomPageDetail): DesktopRoomPageDetail["versions"][number] | null {
  const pending = detail.versions.find((version) => version.status === "pending_approval");
  return pending && pending.version > (detail.currentVersion ?? 0) ? pending : null;
}

/** The live version an Undo goes back to: the newest superseded one before the current version. */
export function previousLiveVersion(detail: DesktopRoomPageDetail): DesktopRoomPageDetail["versions"][number] | null {
  const current = detail.currentVersion;
  if (current === null) return null;
  return detail.versions
    .filter((version) => version.status === "superseded" && version.version < current)
    .sort((a, b) => b.version - a.version)[0] ?? null;
}

/** What one update changed, in words for the "See changes" panel. */
export function pageUpdateChanges(detail: DesktopRoomPageDetail): string[] {
  const current = detail.versions.find((version) => version.version === detail.currentVersion);
  const previous = previousLiveVersion(detail);
  if (!current || !previous) return [];
  const label = (name: string) => pageGrantRows([name])[0].label;
  const added = current.capabilities.filter((name) => !previous.capabilities.includes(name));
  const removed = previous.capabilities.filter((name) => !current.capabilities.includes(name));
  const lines = [`Version ${current.version} replaced version ${previous.version} on ${new Date(current.createdAt).toLocaleString()}.`];
  for (const name of added) lines.push(`Now asks to: ${label(name)}`);
  for (const name of removed) lines.push(`No longer asks to: ${label(name)}`);
  if (!added.length && !removed.length) lines.push("It asks for the same permissions as before.");
  const delta = current.byteSize - previous.byteSize;
  lines.push(delta === 0 ? "The file is the same size." : `The file is ${Math.abs(delta).toLocaleString()} bytes ${delta > 0 ? "larger" : "smaller"}.`);
  return lines;
}

/** What the chat's HTML attachments can do with the room's pages; given by the room shell. */
export interface RoomPageActions {
  /** A room admin in a room on the server. */
  canPin(): boolean;
  pinAttachment(input: { messageId: string; attachmentId: string; fileName: string }): void;
}

export const roomPageActionsKey: InjectionKey<RoomPageActions> = Symbol("roomPageActions");

/** The grant sheet's state, for one page version. */
export interface PageGrantSheetState {
  pageId: string;
  title: string;
  version: number;
  capabilities: string[];
  /** `pin`: approve, then pin as a room tab. `approve`: only approve a waiting version. */
  mode: "pin" | "approve";
}

/**
 * "Pin to room" from an HTML attachment: make the page from the attachment,
 * show the grant sheet when its version waits for permissions, approve the
 * ones the admin keeps, pin it, and open its tab.
 */
export function useRoomPagePinFlow(input: {
  roomId: () => string;
  canPin: () => boolean;
  opened: (pageId: string) => void;
  toast: (message: string, state?: "error" | "info" | "success") => void;
}) {
  const sheet = ref<PageGrantSheetState | null>(null);
  const busy = ref(false);
  const error = ref("");

  function failure(cause: unknown): string {
    const message = cause instanceof Error ? cause.message : String(cause ?? "");
    return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") || "The page could not be pinned.";
  }

  async function pin(pageId: string, title: string): Promise<void> {
    const pinPage = desktopIpc.pages?.pin;
    if (!pinPage) throw new Error("Update LetAgents to pin pages.");
    await pinPage(input.roomId(), pageId);
    requestRoomPagesRefresh();
    input.toast(`${title} is pinned to the room.`, "success");
    input.opened(pageId);
  }

  async function pinAttachment(attachment: { messageId: string; attachmentId: string; fileName: string }): Promise<void> {
    const create = desktopIpc.pages?.createFromAttachment;
    if (!input.canPin() || busy.value) return;
    if (!create) {
      input.toast("Update LetAgents to pin pages.", "error");
      return;
    }
    busy.value = true;
    try {
      const detail = await create(input.roomId(), attachment.messageId, attachment.attachmentId);
      const newest = detail.versions[0];
      if (newest?.status === "pending_approval") {
        error.value = "";
        sheet.value = { pageId: detail.id, title: detail.title, version: newest.version, capabilities: [...newest.capabilities], mode: "pin" };
        return;
      }
      if (detail.currentVersion === null) throw new Error("The page has no live version to pin yet.");
      await pin(detail.id, detail.title);
    } catch (cause) {
      input.toast(failure(cause), "error");
    } finally {
      busy.value = false;
    }
  }

  async function approve(capabilities: string[]): Promise<void> {
    const current = sheet.value;
    const approvePage = desktopIpc.pages?.approve;
    if (!current || busy.value || !approvePage) return;
    busy.value = true;
    error.value = "";
    try {
      await approvePage(input.roomId(), current.pageId, current.version, capabilities);
      if (current.mode === "pin") await pin(current.pageId, current.title);
      else {
        requestRoomPagesRefresh();
        input.toast(`Version ${current.version} of ${current.title} is live.`, "success");
      }
      sheet.value = null;
    } catch (cause) {
      error.value = failure(cause);
    } finally {
      busy.value = false;
    }
  }

  function review(state: PageGrantSheetState): void {
    error.value = "";
    sheet.value = state;
  }

  function cancel(): void {
    if (busy.value) return;
    sheet.value = null;
    error.value = "";
  }

  const actions: RoomPageActions = {
    canPin: input.canPin,
    pinAttachment: (attachment) => { void pinAttachment(attachment); },
  };
  return { sheet, busy, error, approve, review, cancel, actions };
}

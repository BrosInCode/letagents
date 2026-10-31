import type { CalmNoticeInput } from "./room-activity";

/**
 * Why a file did not attach, in the room's own words. The raw error text from
 * main (often "Error invoking remote method …") never reaches the person.
 */
export type AttachmentProblem =
  | { kind: "too-large"; fileName: string | null; limit: string }
  | { kind: "failed"; fileName: string | null }
  | { kind: "too-many"; max: number }
  | { kind: "no-room" }
  | { kind: "restart" };

/** Main's size refusal: "<name> is larger than 25 MB." (shared/message-attachments.mjs). */
const TOO_LARGE = /^(.*?) is larger than (\d+(?:\.\d+)? ?[KMGT]?B)\.?$/;
const NO_ROOM = /^Choose a room before attaching files\.?$/;
const RESTART = /^Restart LetAgents Desktop to enable drag and drop attachments\.?$/;

/** The message main threw, without Electron's IPC wrapper or "Error:" prefixes. */
function thrownText(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^(?:[A-Za-z]*Error:\s*)+/, "").trim();
}

/** Map a failed attach to a known problem. Anything unknown is a plain "Couldn't attach". */
export function attachmentProblemFromError(error: unknown, fileName: string | null = null): AttachmentProblem {
  const text = thrownText(error);
  const tooLarge = TOO_LARGE.exec(text);
  if (tooLarge) return { kind: "too-large", fileName: fileName ?? (tooLarge[1]!.trim() || null), limit: tooLarge[2]! };
  if (NO_ROOM.test(text)) return { kind: "no-room" };
  if (RESTART.test(text)) return { kind: "restart" };
  return { kind: "failed", fileName };
}

/** "Choose another" opens the picker again; "Try again" repeats the attempt that failed. */
export function attachmentProblemNotice(problem: AttachmentProblem): CalmNoticeInput {
  switch (problem.kind) {
    case "too-large":
      return problem.fileName
        ? { icon: "attach", lead: "Couldn't attach ", name: problem.fileName, tail: ` · it's over ${problem.limit}`, action: { key: "choose-attachment", label: "Choose another" } }
        : { icon: "attach", lead: `Couldn't attach the file · it's over ${problem.limit}`, action: { key: "choose-attachment", label: "Choose another" } };
    case "failed":
      return problem.fileName
        ? { icon: "attach", lead: "Couldn't attach ", name: problem.fileName, action: { key: "retry-attachment", label: "Try again" } }
        : { icon: "attach", lead: "Couldn't attach the file", action: { key: "retry-attachment", label: "Try again" } };
    case "too-many":
      return { icon: "attach", lead: `You can attach up to ${problem.max} files to one message` };
    case "no-room":
      return { icon: "attach", lead: "Open a room to attach files" };
    case "restart":
      return { icon: "attach", lead: "Restart LetAgents to drop files here" };
  }
}

/** The same words as one sentence, for a composer that has no activity line (the thread panel). */
export function attachmentProblemText(problem: AttachmentProblem | null): string | null {
  if (!problem) return null;
  const notice = attachmentProblemNotice(problem);
  return `${notice.lead}${notice.name ?? ""}${notice.tail ?? ""}.`;
}

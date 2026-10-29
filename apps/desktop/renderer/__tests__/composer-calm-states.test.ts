import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, effectScope, nextTick, ref } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer } from "vite";

import {
  attachmentProblemFromError,
  attachmentProblemNotice,
  attachmentProblemText,
} from "../src/components/desktop/content/room-chat/attachment-problems";
import {
  ACTIVITY_ACTION_NOTICE_MS,
  ACTIVITY_NOTICE_MS,
  createActivityNoticeQueue,
  type ActivityNotice,
} from "../src/components/desktop/content/room-chat/room-activity";

/** What Electron hands the renderer when a main-process handler throws. */
const ipcError = (message: string) =>
  new Error(`Error invoking remote method 'desktop:room:choose-attachments': Error: ${message}`);

test("known attach failures map to plain words, and no raw IPC text survives", () => {
  assert.deepEqual(attachmentProblemFromError(ipcError("design-review.mov is larger than 25 MB.")),
    { kind: "too-large", fileName: "design-review.mov", limit: "25 MB" });
  assert.deepEqual(attachmentProblemFromError(ipcError("Choose a room before attaching files.")), { kind: "no-room" });
  assert.deepEqual(attachmentProblemFromError(new Error("Restart LetAgents Desktop to enable drag and drop attachments.")), { kind: "restart" });
  assert.deepEqual(attachmentProblemFromError(ipcError("report.pdf upload failed with HTTP 503."), "report.pdf"),
    { kind: "failed", fileName: "report.pdf" });
  assert.deepEqual(attachmentProblemFromError(ipcError("ENOENT: no such file or directory, open '/x/y'")), { kind: "failed", fileName: null });
  assert.deepEqual(attachmentProblemFromError("not an error"), { kind: "failed", fileName: null });
  for (const raw of ["ENOENT: no such file or directory, open '/x/y'", "report.pdf upload failed with HTTP 503.", "Attachment proxy target is outside LetAgents API."]) {
    const text = attachmentProblemText(attachmentProblemFromError(ipcError(raw)))!;
    assert.doesNotMatch(text, /Error invoking|remote method|ENOENT|HTTP|proxy/, raw);
  }
});

test("each attach problem is one calm line with at most one action", () => {
  assert.deepEqual(attachmentProblemNotice({ kind: "too-large", fileName: "design-review.mov", limit: "25 MB" }), {
    icon: "attach", lead: "Couldn't attach ", name: "design-review.mov", tail: " · it's over 25 MB",
    action: { key: "choose-attachment", label: "Choose another" },
  });
  assert.deepEqual(attachmentProblemNotice({ kind: "failed", fileName: "report.pdf" }), {
    icon: "attach", lead: "Couldn't attach ", name: "report.pdf", action: { key: "retry-attachment", label: "Try again" },
  });
  assert.equal(attachmentProblemText({ kind: "failed", fileName: null }), "Couldn't attach the file.");
  assert.equal(attachmentProblemText({ kind: "too-large", fileName: null, limit: "25 MB" }), "Couldn't attach the file · it's over 25 MB.");
  assert.equal(attachmentProblemText({ kind: "too-many", max: 4 }), "You can attach up to 4 files to one message.");
  assert.equal(attachmentProblemText(null), null);
});

function fakeTimers() {
  let now = 1_000_000;
  let next = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    set(run: () => void, ms: number) { const id = next++; pending.set(id, { at: now + ms, run }); return id; },
    clear(handle: unknown) { pending.delete(handle as number); },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = end;
    },
  };
}

test("a calm line with an action stays longer, and a newer confirmation does not lose it", () => {
  const timers = fakeTimers();
  const queue = createActivityNoticeQueue(timers, () => undefined);
  const failed: ActivityNotice = { kind: "calm", id: "calm:1", icon: "attach", lead: "Couldn't attach ", name: "a.pdf", action: { key: "retry-attachment", label: "Try again" } };
  const denied: ActivityNotice = { kind: "calm", id: "calm:2", icon: "check", lead: "Denied 3 requests from ", name: "Juniper" };
  queue.pushFirst(failed);
  timers.advance(ACTIVITY_NOTICE_MS);
  assert.equal(queue.current()?.id, "calm:1", "still on screen after a plain notice's time");
  queue.pushFirst(denied);
  assert.equal(queue.current()?.id, "calm:2");
  timers.advance(ACTIVITY_NOTICE_MS);
  assert.equal(queue.current()?.id, "calm:1", "the line with an action comes back after the confirmation");
  timers.advance(ACTIVITY_ACTION_NOTICE_MS);
  assert.equal(queue.current(), null);
  // A confirmation covered by another confirmation is simply replaced.
  queue.pushFirst(denied);
  queue.pushFirst({ ...denied, id: "calm:3" });
  timers.advance(ACTIVITY_NOTICE_MS);
  assert.equal(queue.current(), null);
});

test("the activity line renders a calm line, announces it, and its one button names the action", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const component = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-chat/RoomActivityLine.vue")).default;
    const render = async (notice: ActivityNotice) => (await renderToString(createSSRApp(component, {
      notice, steer: null, work: [], typingNames: [],
    }))).replace(/ data-v-[a-f0-9]+/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/&#39;/g, "'");
    const html = await render({ kind: "calm", id: "calm:1", ...attachmentProblemNotice({ kind: "too-large", fileName: "design-review.mov", limit: "25 MB" }) });
    assert.match(html, /data-kind="calm"/);
    assert.match(html, />Couldn't attach <strong>design-review\.mov<\/strong> · it's over 25 MB<\/span>/);
    assert.match(html, /data-testid="room-activity-calm-action">Choose another<\/button>/);
    assert.match(html, /aria-atomic="true">Couldn't attach design-review\.mov · it's over 25 MB\. Choose another is available\.</);
    const denied = await render({ kind: "calm", id: "calm:2", icon: "check", lead: "Denied 3 requests from ", name: "Juniper" });
    assert.match(denied, /data-tone="muted"/);
    assert.match(denied, />Denied 3 requests from <strong>Juniper<\/strong><\/span>/);
    assert.doesNotMatch(denied, /room-activity-calm-action/);
  } finally { await vite.close(); }
});

test("a failed attach becomes a problem, and Try again repeats the same dropped files", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const staged: string[][] = [];
  let fail = true;
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { letagentsDesktop: { room: {
    chooseAttachments: async () => { throw ipcError("huge.mov is larger than 25 MB."); },
    stageDroppedAttachmentContents: async (_room: string, files: Array<{ fileName: string }>) => {
      staged.push(files.map(file => file.fileName));
      if (fail) throw ipcError("socket hang up");
      return files.map(file => ({ uploadId: file.fileName, fileName: file.fileName }));
    },
  } } } });
  // Enough of FileReader for readDroppedAttachmentContent.
  const originalReader = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
  Object.defineProperty(globalThis, "FileReader", { configurable: true, writable: true, value: class extends EventTarget {
    result: string | null = null;
    error = null;
    readAsDataURL(file: Blob) {
      void file.arrayBuffer().then(bytes => {
        this.result = `data:${file.type};base64,${Buffer.from(bytes).toString("base64")}`;
        this.dispatchEvent(new Event("load"));
      });
    }
  } });
  const scope = effectScope();
  try {
    const { useRoomAttachments } = await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-chat/useRoomAttachments.ts");
    const attachments = scope.run(() => useRoomAttachments({ roomIdentifier: ref("room-a"), discardAttachment: () => undefined }))!;
    await attachments.pickAttachments();
    assert.deepEqual(attachments.attachmentProblem.value, { kind: "too-large", fileName: "huge.mov", limit: "25 MB" });
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    await attachments.stageDroppedAttachments([file]);
    assert.deepEqual(attachments.attachmentProblem.value, { kind: "failed", fileName: "notes.txt" }, "never the raw 'socket hang up'");
    fail = false;
    await attachments.retryAttachments();
    await nextTick();
    assert.deepEqual(staged, [["notes.txt"], ["notes.txt"]], "Try again sends the same file");
    assert.equal(attachments.attachmentProblem.value, null);
    assert.equal(attachments.attachmentDrafts.value.length, 1);
  } finally {
    scope.stop();
    await vite.close();
    if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window");
    if (originalReader) Object.defineProperty(globalThis, "FileReader", originalReader); else Reflect.deleteProperty(globalThis, "FileReader");
  }
});

test("a chosen or dropped file shows as a chip before its upload finishes", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let finishChosen: (value: unknown) => void = () => undefined;
  let finishDropped: (value: unknown) => void = () => undefined;
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { letagentsDesktop: { room: {
    chooseAttachments: async () => [{ token: "t1", fileName: "shot.png", mimeType: "image/png", sizeBytes: 3, previewDataUrl: "data:image/png;base64,AAA" }],
    stageChosenAttachments: (_room: string, tokens: string[]) => new Promise(resolve => {
      finishChosen = () => resolve(tokens.map(token => ({ uploadId: `up-${token}`, fileName: "shot.png", mimeType: "image/png", sizeBytes: 3, previewDataUrl: null })));
    }),
    stageDroppedAttachmentContents: (_room: string, files: Array<{ fileName: string }>) => new Promise(resolve => {
      finishDropped = () => resolve(files.map(file => ({ uploadId: `up-${file.fileName}`, fileName: file.fileName, mimeType: "text/plain", sizeBytes: 5, previewDataUrl: null })));
    }),
  } } } });
  const originalReader = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
  Object.defineProperty(globalThis, "FileReader", { configurable: true, writable: true, value: class extends EventTarget {
    result: string | null = null;
    error = null;
    readAsDataURL(file: Blob) {
      void file.arrayBuffer().then(bytes => {
        this.result = `data:${file.type};base64,${Buffer.from(bytes).toString("base64")}`;
        this.dispatchEvent(new Event("load"));
      });
    }
  } });
  const scope = effectScope();
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    const { useRoomAttachments } = await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-chat/useRoomAttachments.ts");
    const attachments = scope.run(() => useRoomAttachments({ roomIdentifier: ref("room-a"), discardAttachment: () => undefined }))!;

    const picking = attachments.pickAttachments();
    await settle();
    assert.equal(attachments.attaching.value, false, "the picker is closed; the upload does not block more files");
    assert.deepEqual(attachments.pendingAttachmentDrafts.value.map((draft: { fileName: string; previewDataUrl: string | null }) => [draft.fileName, draft.previewDataUrl]),
      [["shot.png", "data:image/png;base64,AAA"]], "the picked image shows with its preview while it uploads");

    // A drop while the pick still uploads is accepted and shows at once.
    const dropping = attachments.stageDroppedAttachments([new File(["hello"], "notes.txt", { type: "text/plain" })]);
    assert.deepEqual(attachments.pendingAttachmentDrafts.value.map((draft: { fileName: string }) => draft.fileName), ["shot.png", "notes.txt"]);
    assert.equal(attachments.attachmentProblem.value, null);

    finishChosen(undefined);
    await picking;
    assert.deepEqual(attachments.attachmentDrafts.value.map((draft: { uploadId: string; previewDataUrl: string | null }) => [draft.uploadId, draft.previewDataUrl]),
      [["up-t1", "data:image/png;base64,AAA"]], "the picked image keeps its preview after upload");
    assert.deepEqual(attachments.pendingAttachmentDrafts.value.map((draft: { fileName: string }) => draft.fileName), ["notes.txt"]);
    await settle();
    finishDropped(undefined);
    await dropping;
    assert.deepEqual(attachments.attachmentDrafts.value.map((draft: { uploadId: string }) => draft.uploadId), ["up-t1", "up-notes.txt"]);
    assert.equal(attachments.pendingAttachmentDrafts.value.length, 0);
  } finally {
    scope.stop();
    await vite.close();
    if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window");
    if (originalReader) Object.defineProperty(globalThis, "FileReader", originalReader); else Reflect.deleteProperty(globalThis, "FileReader");
  }
});

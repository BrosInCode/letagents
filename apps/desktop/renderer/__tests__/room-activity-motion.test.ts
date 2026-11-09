import assert from "node:assert/strict";
import test from "node:test";
import {
  closeCommandOutput,
  openCommandOutput,
  settleCommandMotion,
} from "../src/components/desktop/content/room-chat/room-activity-motion";

/** A Web Animation that ends only when it is finished or cancelled. */
class FakeAnimation {
  state: "running" | "finished" | "cancelled" = "running";
  private resolve!: () => void;
  readonly finished = new Promise<void>((resolve) => { this.resolve = resolve; });
  finish(): void { if (this.state === "running") this.state = "finished"; this.resolve(); }
  cancel(): void { this.state = "cancelled"; this.resolve(); }
}

/** The strip's list with one command row whose output is open: elements with only what the motion reads. */
function strip(log: string[]) {
  const animations: FakeAnimation[] = [];
  const element = (name: string, children: object[] = [], className = "") => ({
    name,
    children,
    classList: { contains: (token: string) => className.split(" ").includes(token) },
    animate: () => {
      const animation = new FakeAnimation();
      animations.push(animation);
      return animation;
    },
  });
  const state = { listTop: 300 };
  const output = { ...element("output", [], "room-activity-terminal-wrap"), getBoundingClientRect: () => ({ height: 176 }) };
  const head = element("head");
  const command = { ...element("command", [head, output]), querySelector: () => output };
  const agentRow = element("agent row");
  const list = {
    ...element("list", [agentRow, command]),
    scrollHeight: 400,
    clientHeight: 400,
    getBoundingClientRect: () => { log.push(`measure ${state.listTop}`); return { top: state.listTop }; },
  };
  return { list: list as unknown as HTMLElement, command: command as unknown as HTMLElement, animations, state };
}

test("a close that still runs lands at once when the next motion starts, and only once", async () => {
  const log: string[] = [];
  const { list, command, animations, state } = strip(log);
  let applied = 0;
  const closing = closeCommandOutput(list, command, async () => { applied += 1; state.listTop = 476; log.push("close applied"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(applied, 0, "the close's motion runs first");
  assert.ok(animations.length > 0);

  await settleCommandMotion();
  assert.equal(applied, 1, "the next motion's settle puts the output out of the layout");
  assert.ok(animations.every((animation) => animation.state === "cancelled"), "the held end frames go");

  await closing;
  assert.equal(applied, 1, "the close itself does not apply again");
});

test("an open that comes during a close measures the layout after the close has landed", async () => {
  const log: string[] = [];
  const first = strip(log);
  const closing = closeCommandOutput(first.list, first.command, async () => {
    first.state.listTop = 476;
    log.push("close applied");
  });
  await new Promise((resolve) => setImmediate(resolve));
  const opening = openCommandOutput(first.list, first.command, async () => {
    first.state.listTop = 300;
    log.push("open applied");
  });
  await Promise.all([closing, opening]);
  const closeAt = log.indexOf("close applied");
  const openMeasure = log.findIndex((entry, index) => index > closeAt && entry.startsWith("measure"));
  assert.ok(closeAt >= 0 && openMeasure > closeAt, `the open measured after the close landed: ${log.join(", ")}`);
  assert.equal(log.filter((entry) => entry === "close applied").length, 1);
  assert.equal(log.at(-1), "measure 300", "the open measured its own result last");
});

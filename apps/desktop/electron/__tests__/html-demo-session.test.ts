import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";

/** A stand-in for one Electron session: what main set on it, and its handlers. */
class FakeSession {
  proxies: Array<{ proxyRules: string; proxyBypassRules: string }> = [];
  handler: ((request: { url: string }) => Response) | null = null;
  filter: ((details: Record<string, unknown>, callback: (answer: { cancel: boolean }) => void) => void) | null = null;
  protocol = { handle: (_scheme: string, handler: (request: { url: string }) => Response) => { this.handler = handler; } };
  webRequest = { onBeforeRequest: (filter: FakeSession["filter"]) => { this.filter = filter; } };
  async setProxy(config: { proxyRules: string; proxyBypassRules: string }) { this.proxies.push(config); }
  setPermissionRequestHandler() {}
  setPermissionCheckHandler() {}
  setDevicePermissionHandler() {}
  on() {}

  /** Whether the session's request filter lets this request through. */
  allows(url: string, details: { webContentsId?: number; method?: string; resourceType?: string } = {}): boolean {
    let cancel = true;
    this.filter!({ url, method: "GET", resourceType: "script", ...details }, (answer) => { cancel = answer.cancel; });
    return !cancel;
  }

  csp(host: string): string {
    return this.handler!({ url: `letagents-demo://${host}/` }).headers.get("Content-Security-Policy") ?? "";
  }

  lastBypass(): string {
    return this.proxies.at(-1)!.proxyBypassRules;
  }
}

const sessions = new Map<string, FakeSession>();
let userData = "";
const CHART = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
const DEMO_HOST = "0123456789abcdef0123456789abcdef";
const DEMO_CONTENTS = 41;

describe("the demo session and the CDN setting", () => {
  let demo: typeof import("../main/attachments/html-demo-session.js");
  let pages: typeof import("../main/pages/page-session.js");
  const mocks: Array<{ restore: () => void }> = [];

  before(async () => {
    userData = await mkdtemp(join(tmpdir(), "demo-session-"));
    process.env.LETAGENTS_DESKTOP_USER_DATA_DIR = userData;
    mocks.push(
      mock.module("electron", { defaultExport: {
        app: { getPath: () => userData },
        session: { fromPartition: (partition: string) => {
          if (!sessions.has(partition)) sessions.set(partition, new FakeSession());
          return sessions.get(partition);
        } },
      } }),
      mock.module("../main/attachments/protocol.js", { namedExports: {
        attachmentResponse: async () => new Response("unused"),
      } }),
    );
    demo = await import("../main/attachments/html-demo-session.js");
    pages = await import("../main/pages/page-session.js");
  });

  after(async () => {
    for (const stub of mocks.reverse()) stub.restore();
    delete process.env.LETAGENTS_DESKTOP_USER_DATA_DIR;
    await rm(userData, { recursive: true, force: true });
  });

  it("keeps demos offline by default, and follows the switch at once", async () => {
    const ses = await demo.htmlDemoSession() as unknown as FakeSession;
    demo.htmlDemoContents.set(DEMO_CONTENTS, DEMO_HOST);
    assert.equal((await demo.getDesktopDemoSettings()).cdnLibraries, false);
    assert.equal(ses.lastBypass(), "<-loopback>");
    assert.doesNotMatch(ses.csp(DEMO_HOST), /https:/);
    assert.equal(ses.allows(CHART, { webContentsId: DEMO_CONTENTS }), false);

    await demo.setDesktopDemoCdnLibraries(true);
    assert.match(ses.lastBypass(), /https:\/\/cdnjs\.cloudflare\.com/);
    assert.match(ses.csp(DEMO_HOST), /script-src [^;]*https:\/\/cdnjs\.cloudflare\.com/);
    assert.equal(ses.allows(CHART, { webContentsId: DEMO_CONTENTS }), true);
    assert.equal(ses.allows(CHART, { webContentsId: DEMO_CONTENTS, resourceType: "xhr" }), false);

    assert.deepEqual(await demo.setDesktopDemoCdnLibraries(false), {
      cdnLibraries: false,
      cdnHosts: ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"],
    });
    // A running demo's next CDN request is refused, the proxy closes, and the next demo gets the offline CSP.
    assert.equal(ses.allows(CHART, { webContentsId: DEMO_CONTENTS }), false);
    assert.equal(ses.lastBypass(), "<-loopback>");
    assert.doesNotMatch(ses.csp(DEMO_HOST), /https:/);
    assert.deepEqual(JSON.parse(await readFile(join(userData, "demo-settings.json"), "utf8")), { cdnLibraries: false });

    await demo.setDesktopDemoCdnLibraries(true);
    assert.equal(ses.allows(CHART, { webContentsId: DEMO_CONTENTS }), true);
    assert.match(ses.lastBypass(), /https:\/\/unpkg\.com/);
  });

  it("refuses a value that is not on or off, and changes nothing", async () => {
    await assert.rejects(demo.setDesktopDemoCdnLibraries("false"), /Choose on or off/);
    await assert.rejects(demo.setDesktopDemoCdnLibraries(undefined), /Choose on or off/);
    assert.equal((await demo.getDesktopDemoSettings()).cdnLibraries, true);
  });

  it("keeps room pages offline while demos may use the CDNs", async () => {
    assert.equal((await demo.getDesktopDemoSettings()).cdnLibraries, true);
    const ses = await pages.roomPageSession() as unknown as FakeSession;
    assert.notEqual(ses, sessions.get("letagents-html-demos"));
    pages.roomPageContents.set(7, DEMO_HOST);
    assert.equal(ses.lastBypass(), "<-loopback>");
    assert.doesNotMatch(ses.csp(DEMO_HOST), /https:/);
    for (const resourceType of ["script", "stylesheet", "font", "image"]) {
      assert.equal(ses.allows(CHART, { webContentsId: 7, resourceType }), false, resourceType);
    }
  });

  it("changes nothing when the save fails, and the proxy stays with the saved value", async () => {
    const ses = sessions.get("letagents-html-demos")!;
    await demo.setDesktopDemoCdnLibraries(false);
    // A folder where the file should be: the write cannot replace it.
    const path = join(userData, "demo-settings.json");
    await rm(path);
    await mkdir(path);
    const proxiesBefore = ses.proxies.length;
    await assert.rejects(demo.setDesktopDemoCdnLibraries(true));
    assert.equal((await demo.getDesktopDemoSettings()).cdnLibraries, false);
    assert.equal(ses.allows(CHART, { webContentsId: DEMO_CONTENTS }), false);
    assert.equal(ses.proxies.length, proxiesBefore + 1, "the proxy is set again after a failed save");
    assert.equal(ses.lastBypass(), "<-loopback>");
  });
});

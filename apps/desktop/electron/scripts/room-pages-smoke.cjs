// Real-Electron check of two room pages in one window: open page one, open page
// two, switch back and forth, and sample the HOST window's pixels each time, as
// the person sees them (a guest screenshot alone does not show a blank tab).
// Pages are hidden with the rule RoomPageView.vue ships. Run after
// `npm run build:electron`: `npm run smoke:room-pages`.
const { app, BrowserWindow, ipcMain, protocol } = require("electron");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
setTimeout(() => { console.error("room pages smoke: timed out"); process.exit(2); }, 40000).unref?.();
const D = join(__dirname, "..", "..", "dist-electron");
const view = readFileSync(join(__dirname, "..", "..", "renderer", "src", "components", "desktop", "content", "room-pages", "RoomPageView.vue"), "utf8");
const hiddenRule = /\.room-page-view\.is-hidden \{([^}]*)\}/.exec(view)?.[1].trim();
if (!hiddenRule) throw new Error("RoomPageView.vue has no .room-page-view.is-hidden rule");
protocol.registerSchemesAsPrivileged([
  { scheme: "letagents-demo", privileges: { standard: true, secure: true } },
  { scheme: "letagents-page", privileges: { standard: true, secure: true } },
]);
app.whenReady().then(main).catch((e) => { console.error("room pages smoke failed:", e && e.stack); process.exit(1); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const host = await import(`${D}/main/pages/page-host.js`);
  const { createMemoryPageBackend } = await import(`${D}/main/pages/page-adapter.js`);
  const { createPageGrantKeeper } = await import(`${D}/main/pages/page-grants.js`);
  const page = (color, label) => `<!doctype html><html><body style="margin:0;background:${color};height:100vh"><h1 style="color:white">${label}</h1></body></html>`;
  const grants = createPageGrantKeeper();
  const backend = createMemoryPageBackend({ grants, pages: { r1: [
    { id: "p1", title: "One", version: 1, html: page("rgb(220, 0, 0)", "Page one") },
    { id: "p2", title: "Two", version: 1, html: page("rgb(0, 0, 220)", "Page two") },
  ] } });
  grants.configure((r, p, v) => backend.source.grant(r, p, v));
  host.configureRoomPages({ source: backend.source, grants });
  ipcMain.handle("page:call", () => ({ ok: true, value: { mode: "dark", tokens: {} } }));
  const win = new BrowserWindow({ width: 900, height: 600, show: true, x: 0, y: 0, webPreferences: { webviewTag: true, contextIsolation: true, sandbox: false } });
  host.installRoomPageHost(win);
  const hide = hiddenRule;
  await win.loadURL(`data:text/html,${encodeURIComponent(`<!doctype html><style>
    html,body{margin:0;height:100%} #shell{display:grid;grid-template-rows:40px minmax(0,1fr);height:100%}
    .view{grid-row:2;grid-column:1;display:grid} .view webview{width:100%;height:100%} .hidden{${hide}}
  </style><div id="shell"><div style="grid-row:1;background:#222"></div></div>`)}`);
  const js = (code) => win.webContents.executeJavaScript(code);
  const open = async (pageId) => {
    const lease = await host.prepareRoomPage("r1", pageId);
    await js(`(() => { const s = document.createElement("section"); s.className = "view"; s.id = "v-${pageId}";
      s.innerHTML = '<webview src="${lease.url}" partition="${lease.partition}"></webview>'; document.getElementById("shell").appendChild(s); })()`);
  };
  const show = (pageId) => js(`for (const s of document.querySelectorAll(".view")) s.classList.toggle("hidden", s.id !== "v-${pageId}")`);
  const sample = async () => {
    const image = await win.webContents.capturePage({ x: 400, y: 300, width: 4, height: 4 });
    const [b, g, r] = image.toBitmap();
    return r > 150 && b < 80 ? "red" : b > 150 && r < 80 ? "blue" : `other(${r},${g},${b})`;
  };
  const seen = [];
  await open("p1"); await show("p1"); await wait(1500); seen.push(["page 1", await sample()]);
  await open("p2"); await show("p2"); await wait(1500); seen.push(["page 2", await sample()]);
  await show("p1"); await wait(800); seen.push(["back to 1", await sample()]);
  await show("p2"); await wait(800); seen.push(["again 2", await sample()]);
  const expected = [["page 1", "red"], ["page 2", "blue"], ["back to 1", "red"], ["again 2", "blue"]];
  const ok = JSON.stringify(seen) === JSON.stringify(expected);
  console.log(`room pages smoke: ${ok ? "ok" : "FAILED"} ${JSON.stringify(seen)}`);
  app.exit(ok ? 0 : 1);
}

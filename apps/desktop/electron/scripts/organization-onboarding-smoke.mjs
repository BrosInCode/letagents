import { app, BrowserWindow, ipcMain } from 'electron';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const profile = mkdtempSync(join(tmpdir(), 'letagents-org-onboarding-'));
const output = process.env.LETAGENTS_ORG_SMOKE_OUTPUT || join(tmpdir(), 'letagents-org-onboarding-results');
mkdirSync(output, { recursive: true });
app.setPath('userData', profile);
process.env.LETAGENTS_STATE_PATH = join(profile, 'mcp-state.json');
const { desktopSmokeRoomSnapshot } = await import('../../dist-electron/main/smoke.js');
let links = await import('../../dist-electron/main/company-links.js');
let authenticated = false;
let completed = false;
let failOrganizations = false;
let failCompanyTheme = false;
let legacyThemeApi = false;
let holdSetupCompletion = false;
let releaseSetupCompletion;
let holdFirstRoomRead = false;
let releaseFirstRoomRead;
let holdAppInfo = false;
let releaseAppInfo;
let newRoomIdentifier = 'room_q4';
const organizations = [
  { github_org_id: '42', login: 'Herotel', avatar_url: null, theme_id: null, theme_revision: 0, role: 'owner', setup: false, joined: false },
  { github_org_id: '43', login: 'Studio', avatar_url: null, role: 'member', setup: true, joined: false },
  { github_org_id: '44', login: 'WaitingCo', avatar_url: null, role: 'member', setup: false, joined: false },
  { github_org_id: '46', login: 'Northwind', avatar_url: null, role: 'member', setup: true, joined: false },
];
const invitations = [{ github_org_id: '45', login: 'InvitedCo', avatar_url: null }];
const companyRoom = { kind: 'repo', github_repo_id: '100', room_id: 'github.com/herotel/app', display_name: 'app', full_name: 'herotel/app', organization_id: '42', visibility: 'private' };
const createdRooms = [];
const openedGitHubPages = [];
const sentMessages = new Map();
const renamedRooms = new Map();
const account = { id: 'fixture-account', provider: 'github', providerUserId: '1', login: 'alex', displayName: 'Alex', avatarUrl: null };
const auth = () => ({ authenticated, account: authenticated ? account : null, apiUrl: 'https://letagents.chat', pendingDeviceAuth: null, tokenStored: authenticated, error: null });
const target = { id: 'codex', name: 'Codex', description: 'Connect your agents.', configPath: '/fixture/config.toml', configPaths: [], configIssue: null, status: 'installed', lastInstalledAt: null, restartHint: 'Restart your agent app.' };
const setup = () => ({ completed, completedAt: null, selectedTargetId: 'codex', targets: [target] });
const calls = [];
function snapshot(identifier = 'github.com/alex/personal') {
  const value = desktopSmokeRoomSnapshot();
  value.roomIdentifier = identifier;
  value.access.roomIdentifier = identifier;
  Object.assign(value.room, { identifier, name: identifier, displayName: renamedRooms.get(identifier) || identifier.split('/').at(-1), code: identifier });
  const owningCompany = identifier === companyRoom.room_id ? organizations[0] : null;
  if (owningCompany) value.room.companyAppearance = { id: owningCompany.github_org_id, name: owningCompany.login, theme: owningCompany.theme_id, themeRevision: owningCompany.theme_revision };
  value.messages = sentMessages.get(identifier) ?? []; value.tasks = []; value.participants = []; value.presence = []; value.focusRooms = []; value.reasoningSessions = []; value.recentActivity = []; value.roomArtifacts = [];
  return value;
}
ipcMain.handle('fixture:call', async (_event, method, args) => {
  calls.push(method);
  switch (method) {
    case 'auth.getStatus': return auth();
    case 'auth.startDeviceFlow': return { authStatus: { ...auth(), pendingDeviceAuth: { requestId: 'test', userCode: 'TEST-1234', verificationUri: 'https://github.com/login/device', intervalSeconds: 5, expiresAt: new Date(Date.now() + 600000).toISOString() } } };
    case 'auth.pollDeviceFlow': authenticated = true; return { status: 'authorized', authStatus: auth() };
    case 'auth.signOut': authenticated = false; return auth();
    case 'setup.getMcpInstallState': return setup();
    case 'setup.installMcpServer': return { success: true, target, installState: setup(), message: 'Installed' };
    case 'setup.completeMcpOnboarding':
      if (holdSetupCompletion) await new Promise(resolve => { releaseSetupCompletion = resolve; });
      completed = true;
      return setup();
    case 'organizations.list':
      if (failOrganizations) return { status: 'unavailable' };
      return { status: 'ok', organizations: structuredClone(organizations).map(org => {
        if (legacyThemeApi) {
          delete org.theme_id;
          delete org.theme_revision;
        }
        return org;
      }), invitations, ssoRequired: [] };
    case 'organizations.join': {
      const org = organizations.find((org) => org.github_org_id === args[0]);
      assert.ok(org && (org.setup || org.role === 'owner'));
      assert.equal(args[1], !org.setup, 'only an owner of a company nobody set up asks for setup');
      org.setup = true; org.joined = true; return { status: 'ok' };
    }
    case 'organizations.rooms': return { status: 'ok', rooms: [
      ...(args[0] === '42' ? [companyRoom] : []),
      ...createdRooms.filter(room => room.organizationId === args[0]).map(room => ({
        kind: 'room', room_id: 'room_q4', display_name: 'Q4 launch', organization_id: room.organizationId,
        github_repo_id: null, full_name: null, visibility: null,
      })),
    ] };
    case 'organizations.setTheme': {
      if (failCompanyTheme) throw new Error('Fixture company default could not save');
      const org = organizations.find(org => org.github_org_id === args[0]);
      assert.equal(org?.role, 'owner');
      org.theme_id = args[1];
      org.theme_revision += 1;
      return { theme: org.theme_id, themeRevision: org.theme_revision };
    }
    case 'organizations.openOnGitHub': openedGitHubPages.push(args[0]); return;
    case 'room.createInviteRoom': {
      createdRooms.push(args[0] ?? null);
      return { roomIdentifier: newRoomIdentifier, code: 'ROOM-Q4AB', snapshot: snapshot(newRoomIdentifier) };
    }
    case 'room.rename': renamedRooms.set(args[0], args[1]); return { identifier: args[0], name: args[0], displayName: args[1] };
    case 'organizations.pendingInvite': return links.getPendingCompanyLink();
    case 'organizations.acknowledgeInvite': links.acknowledgeCompanyLink(args[0]); return;
    case 'app.getInfo':
      if (holdAppInfo) {
        holdAppInfo = false;
        await new Promise(resolve => { releaseAppInfo = resolve; });
      }
      return { appName: 'LetAgents', appVersion: 'test', platform: 'darwin', versions: process.versions, workspaceRoot: profile, homePath: profile, apiUrl: 'https://letagents.chat' };
    case 'rental.getMarketplace': return { providers: [] };
    case 'room.getSnapshot':
      if (holdFirstRoomRead && args[0] === companyRoom.room_id) {
        holdFirstRoomRead = false;
        await new Promise(resolve => { releaseFirstRoomRead = resolve; });
      }
      return snapshot(args[0] || undefined);
    case 'room.listAccountRooms':
      return [];
    case 'room.getSourceStates': return {};
    case 'room.getMyWork': return { cards: [], next_cursor: null, has_connections: false, providers: [] };
    case 'room.getLatestMessages': return sentMessages.get(args[0]) ?? [];
    case 'room.sendMessage': {
      const [identifier, text, , , , clientMessageId] = args;
      const message = {
        id: "9001", clientMessageId, sender: account.login, text, timestamp: new Date().toISOString(),
        source: "human", actorLabel: null, agentPromptKind: null, agentIdentity: null, attachments: [],
        threadRootId: "9001", threadReplyToId: null, thread: null, replyTo: null,
      };
      sentMessages.set(identifier, [...(sentMessages.get(identifier) ?? []), message]);
      return { message };
    }
    case 'conversations.list': return { conversations: [], version: '0' };
    case 'conversations.changes': return { version: '0' };
    case 'repos.openRoom': {
      const repoPath = args[0];
      const roomIdentifier = 'github.com/herotel/app';
      return {
        canceled: false, repoPath, roomIdentifier, source: 'git_remote', warning: null, error: null,
        repoStatus: { rootPath: repoPath, branch: 'feature/room', worktrees: [] },
        snapshot: snapshot(roomIdentifier),
      };
    }
    case 'repos.getStatus': return { available: false, rootPath: null, roomIdentifier: null, branch: null, worktrees: [] };
    default:
      if (method.includes('list') || method.includes('Bindings') || method.includes('Actions')) return [];
      return null;
  }
});
app.whenReady().then(async () => {
const errors = [];
const hiddenFixture = process.env.LETAGENTS_SMOKE_HIDDEN === '1';
function fixtureWindow(partition) {
  const window = new BrowserWindow({ width: 1280, height: 900, show: !hiddenFixture, webPreferences: { partition, backgroundThrottling: false, contextIsolation: false, nodeIntegration: false, sandbox: false, preload: join(root, 'electron/scripts/fixtures/organization-preload.cjs') } });
  window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${event.sourceId}:${event.lineNumber})`); });
  return window;
}
let window = fixtureWindow();
const js = (source) => window.webContents.executeJavaScript(source, true);
async function waitFor(expression) {
  const until = Date.now() + 15000;
  while (Date.now() < until) { if (await js(expression)) return; await new Promise((resolve) => setTimeout(resolve, 80)); }
  throw new Error(`Timed out: ${expression}\n${await js('document.body.innerText')}\n${errors.join('\n')}`);
}
const click = async (selector) => { await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)})) && !document.querySelector(${JSON.stringify(selector)}).disabled`); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); };
const capture = async (name) => { await new Promise((resolve) => setTimeout(resolve, 550)); writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG()); };
try {
  await window.loadFile(join(root, 'dist-renderer/index.html'));
  await js("document.documentElement.dataset.windowChrome = 'mac'");
  await waitFor(`document.querySelector('[data-testid="first-run-welcome"] canvas')?.width > 300`);
  assert.equal(await js(`document.querySelector('[data-testid="first-run-welcome"]').getBoundingClientRect().top`), 0);
  assert.ok(await js(`document.querySelector('[data-testid="first-run-start-setup"]').getBoundingClientRect().bottom <= innerHeight`));
  assert.match(await js('document.body.innerText'), /Make room to\s+work together/);
  await new Promise(resolve => setTimeout(resolve, 2900));
  await capture('00-animated-welcome.png');
  const runFullscreen = !hiddenFixture && await js(`document.fullscreenEnabled && !matchMedia('(prefers-reduced-motion: reduce)').matches`);
  if (runFullscreen) {
    await click('[data-testid="first-run-welcome"] [aria-label="Full screen"]');
    await waitFor(`document.fullscreenElement === document.documentElement`);
    await click('.welcome-controls button:first-child');
    await waitFor(`document.querySelector('.welcome-controls button:first-child')?.textContent.trim() === 'Play'`);
    await click('.welcome-controls button:nth-child(2)');
    await waitFor(`document.querySelector('.welcome-controls button:first-child')?.textContent.trim() === 'Pause'`);
    assert.ok(await js(`document.fullscreenElement === document.documentElement`), 'replay stays full screen');
    // The macOS Space transition can outlast the DOM fullscreenchange event.
    if (process.platform === 'darwin') {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await click('[data-testid="first-run-start-setup"]');
    await waitFor(`document.querySelector('[data-testid="first-run-welcome"]')?.dataset.handoffState === 'moving'`);
    assert.ok(await js(`document.fullscreenElement === document.documentElement`), 'the particles land in GitHub while full screen');
    await click('[data-testid="first-run-back"]');
    await waitFor(`document.querySelector('[data-testid="first-run-welcome"]')?.dataset.handoffState === 'idle'`);
  }
  window.webContents.debugger.attach();
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await waitFor(`matchMedia('(prefers-reduced-motion: reduce)').matches && !document.querySelector('.welcome-controls button:first-child svg.lucide-pause')`);
  await click('[data-testid="first-run-start-setup"]');
  assert.equal(await js(`document.querySelector('[data-testid="first-run-welcome"]')?.dataset.handoffState`), 'settled');
  assert.equal(await js(`getComputedStyle(document.querySelector('.connection-origin')).animationName`), 'none');
  await click('[data-testid="first-run-back"]');
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
  window.webContents.debugger.detach();

  await click('[data-testid="first-run-start-setup"]');
  await waitFor(`document.querySelector('[data-testid="first-run-welcome"]')?.dataset.handoffState === 'settled'`);
  assert.equal(await js(`document.querySelector('.setup-brand').getBoundingClientRect().top`), 42, 'the wordmark keeps its macOS inset');
  await capture('00-github-sign-in.png');
  const logoTop = await js(`document.querySelector('[data-onboarding-logo-seat]').getBoundingClientRect().top`);
  await click('[data-testid="first-run-auth-start"]');
  await waitFor(`Boolean(document.querySelector('[data-testid="first-run-device-code"]'))`);
  assert.equal(await js(`document.querySelector('.thread-signal')?.tagName`), 'circle');
  assert.ok(Math.abs(logoTop - await js(`document.querySelector('[data-onboarding-logo-seat]').getBoundingClientRect().top`)) < 2, 'the connection stays in place during browser approval');
  await waitFor(`document.querySelector('.github-heading h1')?.textContent === 'Finish in your browser' && !document.querySelector('.github-phase-enter-active')`);
  await capture('00-github-pending.png');
  await click('[data-testid="first-run-auth-poll"]');
  await waitFor(`Boolean(document.querySelector('[data-testid="first-run-auth-account"]'))`);
  assert.equal(await js(`document.querySelector('.thread-check')?.tagName`), 'path');
  await capture('00-github-connected.png');
  await click('[data-testid="first-run-to-room"]');
  assert.equal(calls.includes('setup.installMcpServer'), false);
  // One row per GitHub organization.
  await waitFor(`document.querySelector('[data-stage="organization"]') && Boolean(document.querySelector('[data-testid="company-choice-42"]'))`);
  assert.equal(await js(`document.querySelector('[data-testid="company-choice-44"]').getAttribute('aria-disabled')`), 'true', 'a member waits for an owner');
  await click('.company-github-steps summary');
  assert.ok((await js('document.body.innerText')).includes('Accept on GitHub'), 'a pending GitHub invitation shows its next step');
  await click('.company-github-steps summary');
  await capture('01-company-choice.png');
  await click('[data-testid="company-choice-42"]');
  await waitFor(`(document.querySelector('[data-testid="first-run-company-continue"]')?.textContent || '').includes('Set up Herotel')`);
  await click('[data-testid="first-run-company-continue"]');
  await waitFor(`document.querySelector('[data-stage="theme"] .theme-inherited-status')?.textContent === 'Using default theme'`);
  await capture('01-company-theme.png');
  await click('[data-stage="theme"] input[value="ice"]');
  await waitFor(`document.querySelector('[data-stage="theme"] input[value="ice"]')?.checked`);
  await click('[data-stage="theme"] .theme-inherit');
  await waitFor(`document.querySelector('[data-stage="theme"] .theme-inherited-status')?.textContent === 'Using default theme'`);
  assert.equal(calls.includes('organizations.setTheme'), false, 'previewing a color does not write a company theme');
  await click('[data-stage="theme"] input[value="mint"]');
  await click('.first-run-share-theme input');
  failCompanyTheme = true;
  await click('[data-testid="first-run-theme-continue"]');
  await waitFor(`document.querySelector('[data-testid="first-run-theme-continue"]')?.textContent.includes('Continue with my theme')`);
  assert.ok(await js(`Boolean(document.querySelector('[data-testid="first-run-theme-retry"]'))`));
  const failedSaveCalls = calls.filter(method => method === 'organizations.setTheme').length;
  await click('[data-testid="first-run-theme-continue"]');
  await waitFor(`Boolean(document.querySelector('[data-testid="first-run-company-rooms"]'))`);
  assert.equal(calls.filter(method => method === 'organizations.setTheme').length, failedSaveCalls, 'continuing with a personal theme does not retry the company write');
  assert.equal(organizations[0].theme_id, null, 'the company default remains unset when continuing with a personal theme');
  await click('[data-testid="first-run-back"]');
  await waitFor(`document.querySelector('[data-stage="theme"] input[value="mint"]')?.checked`);
  await click('.first-run-share-theme input');
  await click('[data-testid="first-run-theme-continue"]');
  await waitFor(`Boolean(document.querySelector('[data-testid="first-run-theme-retry"]'))`);
  failCompanyTheme = false;
  await click('[data-testid="first-run-theme-retry"]');
  await waitFor(`document.querySelector('[data-stage="room"]') && Boolean(document.querySelector('[data-testid="first-run-company-rooms"]'))`);
  assert.equal(organizations[0].theme_id, 'mint', 'the owner explicitly saved the shared default during onboarding');
  await js(`{ const input = document.querySelector('.company-room-search input'); input.value = 'missing'; input.dispatchEvent(new Event('input', { bubbles: true })); }`);
  await waitFor(`document.body.innerText.includes('No rooms match your search.')`);
  await js(`{ const input = document.querySelector('.company-room-search input'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }`);
  await capture('02-company-repo-room.png');
  for (const [action, modalStep] of [['create', 'standalone'], ['join', 'join'], ['pick-repo', 'project']]) {
    await click(`[data-testid="room-choice-${action}"]`);
    await waitFor(`Boolean(document.querySelector('[data-testid="new-room-${modalStep}-step"]'))`);
    await click('[aria-label="Close new room dialog"]');
    await waitFor(`!document.querySelector('[data-testid="new-room-modal"]')`);
  }
  const roomChoice = '[data-testid="first-run-company-room-github.com/herotel/app"]';
  assert.ok(await js(`Boolean(document.querySelector('[data-testid="first-run-room-skip"]:enabled'))`), 'the room picker can be skipped');
  const origin = await js(`document.querySelector('${roomChoice} .company-rooms-icon').getBoundingClientRect().toJSON()`);
  const hasMotion = await js(`!matchMedia('(prefers-reduced-motion: reduce)').matches`);
  await js(`void Object.defineProperty(document, 'startViewTransition', { value: undefined, configurable: true })`);
  holdFirstRoomRead = true;
  await click(roomChoice);
  for (let attempt = 0; !releaseFirstRoomRead && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(releaseFirstRoomRead, 'room access is being checked');
  if (hasMotion) {
    assert.ok(await js(`Boolean(document.querySelector('${roomChoice} [data-first-room-departure]'))
      && !document.querySelector('.first-room-flight')`), 'selection is acknowledged in place while access is checked');
  }
  await js(`{
    const style = document.createElement('style');
    style.id = 'defer-sidebar-room-row';
    style.textContent = '.desktop-sidebar-frame [data-sidebar-entry-id][data-active="true"] { display: none !important; }';
    document.head.append(style);
  }`);
  holdAppInfo = true;
  releaseFirstRoomRead();
  await waitFor(`Boolean(document.querySelector('[data-testid="desktop-shell"]'))`);
  assert.ok(await js(`!Array.from(document.querySelectorAll('[data-step="room"] footer button')).some(button => button.textContent.trim() === 'Open room')`),
    'choosing a room does not add a second Open room button while the sidebar loads');
  for (let attempt = 0; !releaseAppInfo && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(releaseAppInfo, 'unrelated app info is pending while the row is missing');
  await new Promise(resolve => setTimeout(resolve, 200));
  await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  assert.ok(await js(`!document.querySelector('.first-room-flight')`), 'landing waits while the sidebar row is still loading');
  if (hasMotion) {
    assert.ok(await js(`{
      const picker = document.querySelector('[data-testid="desktop-first-run-onboarding"][data-room-arrival="waiting"]');
      picker && getComputedStyle(picker).opacity === '1'
        && picker.getBoundingClientRect().height >= innerHeight
        && getComputedStyle(document.querySelector('.app-main')).animationName === 'none'
        && document.querySelector('[data-testid="desktop-shell"]').inert;
    }`), 'the picker still covers the workspace while the landing is unavailable');
  }
  const cancelFlight = process.env.LETAGENTS_SMOKE_CANCEL_ROOM_FLIGHT === '1';
  if (hasMotion) {
    await js(`{
      const source = document.querySelector('${roomChoice} .company-rooms-icon svg');
      source.replaceWith(source.cloneNode(true));
      window.roomFlightSamples = [];
      let originalAnimation;
      const until = performance.now() + 5000;
      function sample(t) {
        const flight = document.querySelector('.first-room-flight');
        if (flight) {
          const target = document.querySelector('[data-first-room-landing]');
          const bounds = flight.getBoundingClientRect();
          const animation = flight.getAnimations()[0];
          originalAnimation ??= animation;
          window.roomFlightSamples.push({
            t, x: bounds.x, y: bounds.y, sameAnimation: animation === originalAnimation, target: target.getBoundingClientRect().toJSON(),
            sameRoom: target.closest('[data-sidebar-entry-id]')?.textContent.includes('app'),
          });
          if (window.roomFlightSamples.length === 3) {
            const replacement = target.cloneNode(true);
            replacement.removeAttribute('data-first-room-landing');
            target.replaceWith(replacement);
          }
          if (${cancelFlight} && window.roomFlightSamples.length === 5) {
            target.closest('[data-sidebar-entry-id]').style.display = 'none';
          }
        } else if (window.roomFlightSamples.length) {
          window.roomFlightEnded = t;
          return;
        }
        if (t < until) requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    }`);
  }
  const rowShownAt = Date.now();
  const rowShown = await js(`{ document.getElementById('defer-sidebar-room-row').remove(); performance.now(); }`);
  if (hasMotion) {
    await waitFor(`Boolean(window.roomFlightEnded)`);
    const samples = await js(`window.roomFlightSamples`);
    writeFileSync(join(output, 'room-flight.json'), JSON.stringify({ origin, rowShown, cancelFlight, samples }, null, 2));
    const first = samples[0], last = samples.at(-1);
    assert.ok(first.sameRoom, 'the flight targets the active room row');
    assert.ok(first.t - rowShown < 250, 'stable row starts the flight while app info is pending');
    assert.ok(samples.every(frame => frame.sameAnimation), 'replacing the target preserves the original animation');
    const dx = first.target.x - origin.x, dy = first.target.y - origin.y;
    const length = Math.hypot(dx, dy);
    assert.ok(Math.hypot(first.x - origin.x, first.y - origin.y) < 3, 'takeoff starts at the picker glyph');
    let prior = -1;
    for (const point of samples) {
      const x = point.x - origin.x, y = point.y - origin.y;
      const along = (dx * x + dy * y) / length;
      assert.ok(Math.abs(dx * y - dy * x) / length < 1, 'each frame follows the direct path');
      assert.ok(along >= prior - .1, 'the flight never reverses');
      if (along > 5 && along < length - 5) assert.ok(along > prior, 'the glyph keeps moving in midair');
      prior = along;
    }
    if (cancelFlight) {
      assert.equal(samples.length, 5, 'no flight frame follows removal of the target row');
      await js(`document.querySelector('[data-sidebar-entry-id][data-active="true"]').style.removeProperty('display')`);
    } else {
      assert.ok(samples.length > 5 && last.t - first.t > 300, 'natural playback spans multiple frames');
      assert.ok(Math.hypot(last.x - first.target.x, last.y - first.target.y) < 3, 'the flight reaches the real row');
    }
    await waitFor(`!document.querySelector('.first-room-flight, [data-first-room-landing], [data-testid="desktop-first-run-onboarding"]')`);
  }
  // The visible row can accept the glyph even if an unrelated refresh stalls.
  await new Promise(resolve => setTimeout(resolve, Math.max(0, 6000 - (Date.now() - rowShownAt))));
  releaseAppInfo();
  await js(`delete document.startViewTransition`);
  await waitFor(`Boolean(document.querySelector('[data-testid="desktop-shell"]'))`);
  if (runFullscreen) {
    assert.ok(await js(`document.fullscreenElement === document.documentElement`), 'room arrival stays full screen');
    await js(`document.exitFullscreen()`);
    await waitFor(`!document.fullscreenElement`);
    if (process.platform === 'darwin') await new Promise(resolve => setTimeout(resolve, 1000));
  }
  // The company filter sits on the Rooms heading.
  await waitFor(`(document.querySelector('[data-testid="sidebar-company-scope"]')?.textContent || '').includes('Herotel')`);
  await waitFor(`document.querySelector('[data-testid="desktop-shell"]')?.dataset.roomTheme === 'mint'`);
  await waitFor(`document.querySelector('[data-testid="room-chat-empty"]')?.textContent.includes('Alex')`);
  await click('[data-testid="room-chat-empty"] button');
  await waitFor(`document.querySelector('[data-testid="room-guided-tour"]')?.open && Boolean(document.querySelector('.room-guide-thread path')?.getAttribute('d'))`);
  const firstThread = await js(`document.querySelector('.room-guide-thread path').getAttribute('d')`);
  await click('[data-testid="room-guide-next"]');
  await waitFor(`document.querySelector('.room-guide-example h2')?.textContent === 'Chat'`);
  assert.notEqual(await js(`document.querySelector('.room-guide-thread path').getAttribute('d')`), firstThread);
  await capture('03-room-tour.png');
  await click('[aria-label="Close quick tour"]');
  await capture('03-company-sidebar.png');
  await js(`{
    const composer = document.querySelector('[data-testid="desktop-composer-input"]');
    composer.focus();
    composer.value = 'First message from onboarding';
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: composer.value }));
  }`);
  await waitFor(`document.querySelector('[data-testid="desktop-composer-send"]')?.disabled === false`);
  const leaveDistance = await js(`new Promise(resolve => {
    const welcome = document.querySelector('[data-testid="room-chat-empty"]');
    const title = welcome.querySelector('h3');
    const previous = title.getBoundingClientRect();
    const observer = new MutationObserver(() => {
      if (!welcome.classList.contains('room-empty-leave-active')) return;
      const after = title.getBoundingClientRect();
      observer.disconnect();
      clearTimeout(deadline);
      resolve(Math.hypot(after.top - previous.top, after.left - previous.left));
    });
    const deadline = setTimeout(() => { observer.disconnect(); resolve(null); }, 800);
    observer.observe(welcome, { attributes: true, attributeFilter: ['class'] });
    document.querySelector('[data-testid="desktop-composer-send"]').click();
  })`);
  assert.ok(leaveDistance !== null && leaveDistance < 6, `the welcome stays in place while fading (shift: ${leaveDistance})`);
  await waitFor(`Boolean(document.querySelector('[data-testid="room-message-9001"]')) && !document.querySelector('[data-testid="room-chat-empty"]')`);
  assert.equal(sentMessages.get(companyRoom.room_id)?.length, 1);
  await capture('03-first-message.png');
  await click('[data-testid="sidebar-account-trigger"]');
  await click('[data-testid="sidebar-account-settings"]');
  await click('[data-testid="settings-nav-system:styling"]');
  await click('.company-theme-settings summary');
  await click('.company-theme-settings input[value="violet"]');
  await click('.save-company-theme');
  await waitFor(`document.querySelector('[data-testid="desktop-shell"]')?.dataset.roomTheme === 'violet'`);
  await click('.theme-settings > .room-theme-picker input[value="ice"]');
  await waitFor(`document.querySelector('[data-testid="desktop-shell"]')?.dataset.roomTheme === 'ice'`);
  await click('.theme-settings > .room-theme-picker .theme-inherit');
  await waitFor(`document.querySelector('[data-testid="desktop-shell"]')?.dataset.roomTheme === 'violet'`);
  await capture('03-company-styling.png');
  await click('[data-testid="settings-back-to-app"]');
  await click('[data-testid="sidebar-company-scope"]');
  await waitFor(`Boolean(document.querySelector('[data-testid="sidebar-company-menu"]'))`);
  await capture('04-company-menu.png');
  await click('[data-testid="company-menu-43"]');
  await waitFor(`Boolean(document.querySelector('[data-testid="company-home"][data-state="empty"]'))`);
  await capture('05-empty-company.png');
  failOrganizations = true;
  await click('[data-testid="sidebar-company-scope"]');
  await click('[data-testid="company-menu-refresh"]');
  await waitFor(`Boolean(document.querySelector('[data-testid="company-home"][data-state="unavailable"]'))`);
  await capture('06-github-unavailable.png');
  failOrganizations = false;
  await click('[data-testid="company-home-retry"]');
  await waitFor(`Boolean(document.querySelector('[data-testid="company-home"][data-state="empty"]'))`);
  await click('[data-testid="sidebar-company-scope"]');
  await click('[data-testid="company-menu-all"]');
  await waitFor(`(document.querySelector('[data-testid="sidebar-company-scope"]')?.textContent || '').trim().startsWith('Rooms') && !document.querySelector('[data-testid="company-home"]')`);
  // A company link opens a dialog over any view, and survives a restart until it is answered.
  await click('[data-testid="sidebar-my-work"]');
  await waitFor(`Boolean(document.querySelector('[data-testid="my-work-view"]'))`);
  // Restore a persisted invite without asking the production dispatcher to open
  // its own window. This process only has the fixture window and IPC bridge.
  writeFileSync(join(profile, 'pending-company-link.json'), JSON.stringify({ organizationId: '46' }), { mode: 0o600 });
  links = await import('../../dist-electron/main/company-links.js?restart');
  assert.equal(links.getPendingCompanyLink(), '46');
  links.acknowledgeCompanyLink('43');
  assert.equal(links.getPendingCompanyLink(), '46');
  window.webContents.send('fixture:invite', '46');
  await waitFor(`Boolean(document.querySelector('[data-testid="company-invite-join"]'))`);
  assert.deepEqual(BrowserWindow.getAllWindows().map(candidate => candidate.id), [window.id], 'an invite stays in the fixture window');
  assert.ok((await js('document.body.innerText')).includes('Join Northwind'));
  await capture('07-company-invitation.png');
  window.setSize(600, 800);
  await js(`document.documentElement.dataset.theme = 'light'; document.documentElement.style.colorScheme = 'light'`);
  await capture('07-company-invitation-light-narrow.png');
  assert.equal(await js(`document.documentElement.scrollWidth > innerWidth`), false);
  window.setSize(1280, 900);
  await js(`document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark'`);
  await click('[data-testid="company-invite-join"]');
  await waitFor(`document.body.innerText.includes('You’re in Northwind')`);
  await capture('08-company-joined.png');
  await click('[data-testid="company-invite-show_rooms"]');
  await waitFor(`!document.querySelector('[data-testid="company-invite-dialog"]') && (document.querySelector('[data-testid="sidebar-company-scope"]')?.textContent || '').includes('Northwind')`);
  assert.equal(links.getPendingCompanyLink(), null);
  // New room starts at the draft in the selected company.
  await click('[data-testid="sidebar-new-room"]');
  const organizationTrigger = '[data-testid="new-room-organization"] button[aria-haspopup="listbox"]';
  const accessTrigger = '[data-testid="new-room-storage"] button[aria-haspopup="listbox"]';
  const option = (label) => js(`[...document.querySelectorAll('[popover]:popover-open [role="option"]')].find(item => item.textContent.trim().endsWith(${JSON.stringify(label)})).click()`);
  await waitFor(`document.querySelector(${JSON.stringify(organizationTrigger)})?.getAttribute('aria-label') === 'Organization: Northwind'`);
  await click(organizationTrigger);
  await option('Personal');
  await click(accessTrigger);
  await option('Only on this device');
  await click(organizationTrigger);
  await option('Northwind');
  await click(organizationTrigger);
  await option('Personal');
  await waitFor(`document.querySelector(${JSON.stringify(accessTrigger)})?.getAttribute('aria-label') === 'Room access: Only on this device'`);
  await click(organizationTrigger);
  await option('Herotel');
  // A project preview replaces the room identity and removing it restores the draft.
  await js(`{ const input = document.querySelector('[data-testid="new-room-name-input"]'); input.value = 'Q4 launch'; input.dispatchEvent(new Event('input', { bubbles: true })); }`);
  await click('[data-testid="new-room-add-project"]');
  await click('button.desktop-new-room-text-button');
  await js(`{ const input = document.querySelector('[data-testid="new-room-project-path-input"]'); input.value = '/fixture/app'; input.dispatchEvent(new Event('input', { bubbles: true })); }`);
  await js(`document.querySelector('[data-testid="new-room-project-path-submit"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))`);
  await click('[data-testid="new-room-project-path-submit"]');
  await waitFor(`document.querySelector('[data-testid="new-room-project-preview"]')?.textContent.includes('feature/room')`);
  await waitFor(`document.querySelector('[data-testid="new-room-confirm-project"]') === document.activeElement`);
  await capture('09-project-room.png');
  await click('button[aria-label="Remove project"]');
  await waitFor(`document.querySelector('[data-testid="new-room-name-input"]')?.value === 'Q4 launch'`);
  assert.equal(await js(`document.querySelector(${JSON.stringify(organizationTrigger)})?.getAttribute('aria-label')`), 'Organization: Herotel');
  await capture('09-new-company-room.png');
  await click(organizationTrigger);
  await waitFor(`Boolean(document.querySelector('[popover]:popover-open [role="option"][aria-selected="true"]'))`);
  await capture('09-new-company-room-menu.png');
  await js(`document.querySelector('[popover]:popover-open [role="option"][aria-selected="true"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitFor(`!document.querySelector('[popover]:popover-open') && Boolean(document.querySelector('[data-testid="new-room-modal"]'))`);
  await click('[data-testid="new-room-create-standalone"]');
  await waitFor(`!document.querySelector('[data-testid="new-room-modal"]') && document.querySelector('[data-testid="sidebar-company-scope"]')?.textContent.includes('Herotel') && document.body.innerText.includes('Q4 launch')`);
  assert.deepEqual(createdRooms, [{ organizationId: '42' }]);
  // A pasted company link opens the company dialog instead of joining a room.
  await click('[data-testid="sidebar-new-room"]');
  await click('[data-testid="new-room-join-entry"]');
  await js(`{ const input = document.querySelector('[data-testid="new-room-join-input"]'); input.value = 'https://letagents.chat/company/42'; input.dispatchEvent(new Event('input', { bubbles: true })); }`);
  await click('[data-testid="new-room-join-submit"]');
  await waitFor(`Boolean(document.querySelector('[data-testid="company-invite-dialog"]')) && document.body.innerText.includes('Show Herotel rooms')`);
  await click('[data-testid="company-invite-show_rooms"]');
  await waitFor(`!document.querySelector('[data-testid="company-invite-dialog"]') && (document.querySelector('[data-testid="sidebar-company-scope"]')?.textContent || '').includes('Herotel')`);
  // Opening a room outside the company switches back to All rooms, so the room never hides.
  await click('[data-testid="sidebar-new-room"]');
  await click('[data-testid="new-room-join-entry"]');
  await js(`{ const input = document.querySelector('[data-testid="new-room-join-input"]'); input.value = 'github.com/alex/personal'; input.dispatchEvent(new Event('input', { bubbles: true })); }`);
  await click('[data-testid="new-room-join-submit"]');
  await waitFor(`(document.querySelector('[data-testid="sidebar-company-scope"]')?.textContent || '').trim().startsWith('Rooms') && !document.querySelector('[data-testid="company-home"]')`);
  await capture('10-explicit-personal-room.png');

  // Reopen setup as a signed-in account to exercise successful creation from the wizard.
  completed = false;
  newRoomIdentifier = 'room_onboarding_qa';
  legacyThemeApi = true;
  const previousWindow = window;
  window = fixtureWindow('onboarding-room-handoff');
  previousWindow.destroy();
  await window.loadFile(join(root, 'dist-renderer/index.html'));
  await click('[data-testid="first-run-start-setup"]');
  await click('[data-testid="first-run-to-room"]');
  await click('[data-testid="company-choice-42"]');
  await click('[data-testid="first-run-company-continue"]');
  await waitFor(`document.querySelector('[data-stage="theme"] .room-theme-picker')`);
  assert.ok(await js(`!document.querySelector('.first-run-share-theme')`), 'an API without theme revisions does not offer a company write');
  const legacySaveCalls = calls.filter(method => method === 'organizations.setTheme').length;
  await click('[data-stage="theme"] input[value="graphite"]');
  await click('[data-testid="first-run-theme-continue"]');
  await waitFor(`Boolean(document.querySelector('[data-testid="first-run-company-rooms"]'))`);
  assert.equal(calls.filter(method => method === 'organizations.setTheme').length, legacySaveCalls, 'the personal theme works on the older API');
  await click('[data-testid="first-run-back"]');
  await waitFor(`document.querySelector('[data-stage="theme"] input[value="graphite"]')?.checked`);
  await click('[data-testid="first-run-back"]');
  await click('[data-testid="company-choice-all"]');
  await click('[data-testid="first-run-company-continue"]');
  await click('[data-testid="first-run-theme-continue"]');
  await click('[data-testid="room-choice-create"]');
  await js(`{
    const name = document.querySelector('[data-testid="new-room-name-input"]');
    name.value = 'Onboarding QA';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    window.onboardingRoomFrames = new Set();
    const sample = () => {
      const surface = document.querySelector('[data-testid="desktop-first-run-splash"]') ? 'startup'
        : document.querySelector('[data-testid="room-chat-empty"]') ? 'chat'
        : document.querySelector('[data-testid="new-room-modal"]:not(.new-room-modal-leave-active)') ? 'creation'
        : 'intermediate';
      window.onboardingRoomFrames.add(surface);
      if (surface !== 'chat') requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }`);
  holdSetupCompletion = true;
  await click('[data-testid="new-room-create-standalone"]');
  for (let attempt = 0; !releaseSetupCompletion && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(releaseSetupCompletion, 'creation has reached the slow setup save');
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.ok(await js(`Boolean(document.querySelector('[data-testid="new-room-modal"]:not(.new-room-modal-leave-active)'))`), 'the creation dialog stays until chat can mount');
  releaseSetupCompletion();
  await waitFor(`document.querySelector('[data-testid="room-chat-empty"]')?.textContent.includes('Onboarding QA') && !document.querySelector('[data-testid="new-room-modal"]')`);
  assert.deepEqual(await js('[...window.onboardingRoomFrames]'), ['creation', 'chat'], 'creation reveals chat directly, without a startup or room-picker frame');
  assert.ok(await js(`Boolean(document.querySelector('[data-testid="desktop-composer-input"]'))`));
  assert.equal(createdRooms.length, 2, 'the onboarding handoff creates the new room once');
  await capture('11-onboarding-created-room.png');
  assert.deepEqual(errors, [], 'renderer must not report uncaught errors');
  const report = { passed: true, checks: ['animated desktop welcome and GitHub without MCP', 'real New Room entry points', 'room arrival, tour and first message', 'first-run owner setup', 'company theme inheritance, owner updates and personal overrides', 'member waiting for owner', 'pending GitHub invitation', 'company repo room on the room step', 'company filter on the Rooms heading', 'empty company home', 'GitHub outage and retry', 'All rooms fallback', 'company link persistence and acknowledgement', 'company link dialog over any view', 'join from a company link', 'new room inside the company', 'pasted company link', 'explicit outside-company room opens in All rooms', 'first-run creation transitions directly to chat with a slow setup save'], consoleErrors: errors, calls: [...new Set(calls)] };
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, output, consoleErrors: errors }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await capture('failure.png').catch(() => undefined);
} finally {
  window.destroy();
  rmSync(profile, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
}

}).catch((error) => { console.error(error); app.exit(1); });

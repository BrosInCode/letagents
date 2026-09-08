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
const links = await import('../../dist-electron/main/company-links.js');
let authenticated = false;
let completed = false;
let failOrganizations = false;
const organizations = [
  { github_org_id: '42', login: 'Acme', avatar_url: null, role: 'owner', setup: false, joined: false },
  { github_org_id: '43', login: 'Studio', avatar_url: null, role: 'member', setup: true, joined: false },
  { github_org_id: '44', login: 'WaitingCo', avatar_url: null, role: 'member', setup: false, joined: false },
];
const companyRoom = { github_repo_id: '100', room_id: 'github.com/acme/app', display_name: 'app', full_name: 'acme/app', organization_id: '42', visibility: 'private' };
const account = { id: 'fixture-account', provider: 'github', providerUserId: '1', login: 'alex', displayName: 'Alex', avatarUrl: null };
const auth = () => ({ authenticated, account: authenticated ? account : null, apiUrl: 'https://letagents.chat', pendingDeviceAuth: null, tokenStored: authenticated, error: null });
const target = { id: 'codex', name: 'Codex', description: 'Connect your agents.', configPath: '/fixture/config.toml', configPaths: [], configIssue: null, status: 'installed', lastInstalledAt: null, restartHint: 'Restart your agent app.' };
const setup = () => ({ completed, completedAt: null, selectedTargetId: 'codex', targets: [target] });
const calls = [];
function snapshot(identifier = 'github.com/alex/personal') {
  const value = desktopSmokeRoomSnapshot();
  value.roomIdentifier = identifier;
  value.access.roomIdentifier = identifier;
  Object.assign(value.room, { identifier, name: identifier, displayName: identifier.split('/').at(-1), code: identifier });
  value.messages = []; value.tasks = []; value.participants = []; value.presence = []; value.focusRooms = []; value.reasoningSessions = []; value.recentActivity = []; value.roomArtifacts = [];
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
    case 'setup.completeMcpOnboarding': completed = true; return setup();
    case 'organizations.list': if (failOrganizations) throw new Error('Fixture GitHub unavailable'); return organizations;
    case 'organizations.join': {
      const org = organizations.find((org) => org.github_org_id === args[0]);
      assert.ok(org && (org.setup || org.role === 'owner'));
      org.setup = true; org.joined = true; return;
    }
    case 'organizations.rooms': return args[0] === '42' ? [companyRoom] : [];
    case 'organizations.pendingInvite': return links.getPendingCompanyLink();
    case 'organizations.acknowledgeInvite': links.acknowledgeCompanyLink(args[0]); return;
    case 'app.getInfo': return { appName: 'LetAgents', appVersion: 'test', platform: 'darwin', versions: process.versions, workspaceRoot: profile, homePath: profile, apiUrl: 'https://letagents.chat' };
    case 'rental.getMarketplace': return { providers: [] };
    case 'room.getSnapshot': return snapshot(args[0] || undefined);
    case 'room.listAccountRooms': return [];
    case 'room.getSourceStates': return {};
    case 'room.getLatestMessages': return [];
    case 'repos.getStatus': return { available: false, rootPath: null, roomIdentifier: null, branch: null, worktrees: [] };
    default:
      if (method.includes('list') || method.includes('Bindings') || method.includes('Actions')) return [];
      return null;
  }
});
app.whenReady().then(async () => {
const window = new BrowserWindow({ width: 1280, height: 900, show: true, webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false, preload: join(root, 'electron/scripts/fixtures/organization-preload.cjs') } });
const errors = [];
window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
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
  await click('[data-testid="first-run-start-setup"]');
  await click('[data-testid="first-run-mcp-continue"]');
  await click('[data-testid="first-run-mcp-install"]');
  await click('[data-testid="first-run-to-github"]');
  await click('[data-testid="first-run-auth-start"]');
  await click('[data-testid="first-run-auth-poll"]');
  await waitFor(`document.querySelector('[data-stage="organization"]') && document.body.innerText.includes('Acme')`);
  await capture('01-company-choice.png');
  assert.equal(await js(`Array.from(document.querySelectorAll('.company-choice')).find(e => e.textContent.includes('WaitingCo')).disabled`), true);
  await js(`Array.from(document.querySelectorAll('.company-choice')).find(e => e.textContent.includes('Acme')).click()`);
  await waitFor(`document.querySelector('[data-stage="room"]') && document.body.innerText.includes('acme/app')`);
  await capture('02-company-repo-room.png');
  await js(`Array.from(document.querySelectorAll('.company-room-list button')).find(e => e.textContent.includes('acme/app')).click()`);
  await waitFor(`document.body.innerText.includes('Open room')`);
  await click('[data-testid="first-run-open-room"]');
  await waitFor(`Boolean(document.querySelector('[data-testid="desktop-shell"]'))`);
  await capture('03-company-sidebar.png');
  await js(`const scope = document.querySelector('#company-scope'); scope.value = '43'; scope.dispatchEvent(new Event('change', {bubbles:true}));`);
  await waitFor(`document.querySelector('#company-scope')?.value === '43' && document.body.innerText.includes('No rooms here yet')`);
  await capture('04-empty-company.png');
  failOrganizations = true;
  await click('[aria-label="Refresh companies and rooms"]');
  await waitFor(`document.body.innerText.includes('Couldn’t verify')`);
  await capture('05-retry-state.png');
  failOrganizations = false;
  await js(`document.querySelector('#company-scope').value = ''; document.querySelector('#company-scope').dispatchEvent(new Event('change', {bubbles:true}));`);
  await waitFor(`document.querySelector('#company-scope')?.value === ''`);
  await click('[data-testid="sidebar-rent"]');
  await waitFor(`Boolean(document.querySelector('[data-testid="rent-marketplace-view"]'))`);
  links.acceptCompanyLink('letagents://join/42');
  assert.equal(links.getPendingCompanyLink(), '42');
  const reloadedLinks = await import(`../../dist-electron/main/company-links.js?restart=${Date.now()}`);
  assert.equal(reloadedLinks.getPendingCompanyLink(), '42');
  links.acknowledgeCompanyLink('43');
  assert.equal(links.getPendingCompanyLink(), '42');
  window.webContents.send('fixture:invite', '42');
  await waitFor(`document.body.innerText.includes('following a company invitation') && !document.querySelector('.company-choice')?.disabled`);
  assert.equal(await js(`Boolean(document.querySelector('[data-testid="rent-marketplace-view"]'))`), false);
  await capture('06-company-invitation.png');
  await click('.company-choice');
  await waitFor(`!document.body.innerText.includes('following a company invitation')`);
  assert.equal(links.getPendingCompanyLink(), null);
  await click('[data-testid="sidebar-new-room"]');
  await click('[data-testid="new-room-intent-join"]');
  await js(`const input = document.querySelector('[data-testid="new-room-join-input"]'); input.value = 'github.com/alex/personal'; input.dispatchEvent(new Event('input', { bubbles: true }));`);
  await click('[data-testid="new-room-join-submit"]');
  await waitFor(`document.querySelector('#company-scope')?.value === '' && !document.querySelector('[data-testid="company-home"]')`);
  await capture('07-explicit-personal-room.png');
  assert.deepEqual(errors, [], 'renderer must not report uncaught errors');
  const report = { passed: true, checks: ['first-run owner setup', 'member waiting for owner', 'repo is room selection', 'company sidebar', 'multi-company empty state', 'provider failure and retry', 'personal fallback', 'native invite persistence and acknowledgement', 'signed-in invitation', 'invitation replaces marketplace', 'explicit outside-company room opens in personal scope'], consoleErrors: errors, calls: [...new Set(calls)] };
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, output, consoleErrors: errors }, null, 2));
} catch (error) {
  await capture('failure.png');
  console.error(error);
  process.exitCode = 1;
} finally {
  window.destroy();
  rmSync(profile, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
}

}).catch((error) => { console.error(error); app.exit(1); });

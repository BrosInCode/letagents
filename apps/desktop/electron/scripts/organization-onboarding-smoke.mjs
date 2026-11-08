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
  { github_org_id: '42', login: 'Herotel', avatar_url: null, role: 'owner', setup: false, joined: false },
  { github_org_id: '43', login: 'Studio', avatar_url: null, role: 'member', setup: true, joined: false },
  { github_org_id: '44', login: 'WaitingCo', avatar_url: null, role: 'member', setup: false, joined: false },
  { github_org_id: '46', login: 'Northwind', avatar_url: null, role: 'member', setup: true, joined: false },
];
const invitations = [{ github_org_id: '45', login: 'InvitedCo', avatar_url: null }];
const companyRoom = { kind: 'repo', github_repo_id: '100', room_id: 'github.com/herotel/app', display_name: 'app', full_name: 'herotel/app', organization_id: '42', visibility: 'private' };
const createdRooms = [];
const openedGitHubPages = [];
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
    case 'organizations.list':
      if (failOrganizations) return { status: 'unavailable' };
      return { status: 'ok', organizations: structuredClone(organizations), invitations, ssoRequired: [] };
    case 'organizations.join': {
      const org = organizations.find((org) => org.github_org_id === args[0]);
      assert.ok(org && (org.setup || org.role === 'owner'));
      assert.equal(args[1], !org.setup, 'only an owner of a company nobody set up asks for setup');
      org.setup = true; org.joined = true; return { status: 'ok' };
    }
    case 'organizations.rooms': return { status: 'ok', rooms: args[0] === '42' ? [companyRoom] : [] };
    case 'organizations.openOnGitHub': openedGitHubPages.push(args[0]); return;
    case 'room.createInviteRoom': {
      createdRooms.push(args[0] ?? null);
      return { roomIdentifier: 'room_q4', code: 'ROOM-Q4AB', snapshot: snapshot('room_q4') };
    }
    case 'room.rename': return { identifier: 'room_q4', name: 'room_q4', displayName: 'Q4 launch' };
    case 'organizations.pendingInvite': return links.getPendingCompanyLink();
    case 'organizations.acknowledgeInvite': links.acknowledgeCompanyLink(args[0]); return;
    case 'app.getInfo': return { appName: 'LetAgents', appVersion: 'test', platform: 'darwin', versions: process.versions, workspaceRoot: profile, homePath: profile, apiUrl: 'https://letagents.chat' };
    case 'rental.getMarketplace': return { providers: [] };
    case 'room.getSnapshot': return snapshot(args[0] || undefined);
    case 'room.listAccountRooms': return [];
    case 'room.getSourceStates': return {};
    case 'room.getLatestMessages': return [];
    case 'conversations.list': return { conversations: [], version: '0' };
    case 'conversations.changes': return { version: '0' };
    case 'repos.getStatus': return { available: false, rootPath: null, roomIdentifier: null, branch: null, worktrees: [] };
    default:
      if (method.includes('list') || method.includes('Bindings') || method.includes('Actions')) return [];
      return null;
  }
});
app.whenReady().then(async () => {
const window = new BrowserWindow({ width: 1280, height: 900, show: true, webPreferences: { backgroundThrottling: false, contextIsolation: false, nodeIntegration: false, sandbox: false, preload: join(root, 'electron/scripts/fixtures/organization-preload.cjs') } });
const errors = [];
window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(`${event.message} (${event.sourceId}:${event.lineNumber})`); });
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
  // Step 3 of setup: one row per GitHub organization, chosen like the other setup steps.
  await waitFor(`document.querySelector('[data-stage="organization"]') && Boolean(document.querySelector('[data-testid="company-choice-42"]'))`);
  assert.equal(await js(`document.querySelector('[data-testid="company-choice-44"]').getAttribute('aria-disabled')`), 'true', 'a member waits for an owner');
  await click('.company-github-steps summary');
  assert.ok((await js('document.body.innerText')).includes('Accept on GitHub'), 'a pending GitHub invitation shows its next step');
  await click('.company-github-steps summary');
  await capture('01-company-choice.png');
  await click('[data-testid="company-choice-42"]');
  await waitFor(`(document.querySelector('[data-testid="first-run-company-continue"]')?.textContent || '').includes('Set up Herotel')`);
  await click('[data-testid="first-run-company-continue"]');
  await waitFor(`document.querySelector('[data-stage="room"]') && Boolean(document.querySelector('[data-testid="first-run-company-rooms"]'))`);
  await js(`{ const input = document.querySelector('.company-room-search input'); input.value = 'missing'; input.dispatchEvent(new Event('input', { bubbles: true })); }`);
  await waitFor(`document.body.innerText.includes('No rooms match your search.')`);
  await js(`{ const input = document.querySelector('.company-room-search input'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }`);
  await capture('02-company-repo-room.png');
  await click('[data-testid="first-run-company-room-github.com/herotel/app"]');
  await waitFor(`(document.querySelector('[data-testid="first-run-open-room"]')?.textContent || '').includes('Open herotel/app')`);
  await click('[data-testid="first-run-open-room"]');
  await waitFor(`Boolean(document.querySelector('[data-testid="desktop-shell"]'))`);
  // The company filter sits on the Rooms heading.
  await waitFor(`(document.querySelector('[data-testid="sidebar-company-scope"]')?.textContent || '').includes('Herotel')`);
  await capture('03-company-sidebar.png');
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
  await click('[data-testid="sidebar-rent"]');
  await waitFor(`Boolean(document.querySelector('[data-testid="rent-marketplace-view"]'))`);
  links.acceptCompanyLink('letagents://company/46');
  assert.equal(links.getPendingCompanyLink(), '46');
  const reloadedLinks = await import(`../../dist-electron/main/company-links.js?restart=${Date.now()}`);
  assert.equal(reloadedLinks.getPendingCompanyLink(), '46');
  links.acknowledgeCompanyLink('43');
  assert.equal(links.getPendingCompanyLink(), '46');
  window.webContents.send('fixture:invite', '46');
  await waitFor(`Boolean(document.querySelector('[data-testid="company-invite-join"]'))`);
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
  // The company owns work rooms: a new blank room is created in the selected company.
  await click('[data-testid="sidebar-new-room"]');
  await click('[data-testid="new-room-modal"] [role="tab"][id$="-tab-standalone"]');
  await waitFor(`document.querySelector('[data-testid="new-room-storage"] button')?.getAttribute('aria-label') === 'Where it lives: Northwind'`);
  await click('[data-testid="new-room-storage"] button');
  await waitFor(`Boolean(document.querySelector('[popover]:popover-open [role="option"][aria-selected="true"]'))`);
  await js(`document.querySelector('[popover]:popover-open [role="option"]:last-child').click()`);
  await waitFor(`document.querySelector('[data-testid="new-room-storage-description"]')?.textContent.includes('stays on this device')`);
  await click('[data-testid="new-room-storage"] button');
  await js(`document.querySelector('[popover]:popover-open [role="option"]:first-child').click()`);
  await waitFor(`document.querySelector('[data-testid="new-room-storage"] button')?.getAttribute('aria-label') === 'Where it lives: Northwind'`);
  await capture('09-new-company-room.png');
  await click('[data-testid="new-room-storage"] button');
  await waitFor(`Boolean(document.querySelector('[popover]:popover-open [role="option"][aria-selected="true"]'))`);
  await capture('09-new-company-room-menu.png');
  await js(`document.querySelector('[popover]:popover-open [role="option"][aria-selected="true"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitFor(`!document.querySelector('[popover]:popover-open') && Boolean(document.querySelector('[data-testid="new-room-modal"]'))`);
  await click('[data-testid="new-room-create-standalone"]');
  await waitFor(`Boolean(document.querySelector('[data-testid="new-room-success-step"]'))`);
  assert.deepEqual(createdRooms, [{ organizationId: '46' }]);
  await click('[data-testid="new-room-done"]');
  await waitFor(`!document.querySelector('[data-testid="new-room-modal"]')`);
  // A pasted company link opens the company dialog instead of joining a room.
  await click('[data-testid="sidebar-new-room"]');
  await click('[data-testid="new-room-modal"] [role="tab"][id$="-tab-join"]');
  await js(`{ const input = document.querySelector('[data-testid="new-room-join-input"]'); input.value = 'https://letagents.chat/company/42'; input.dispatchEvent(new Event('input', { bubbles: true })); }`);
  await click('[data-testid="new-room-join-submit"]');
  await waitFor(`Boolean(document.querySelector('[data-testid="company-invite-dialog"]')) && document.body.innerText.includes('Show Herotel rooms')`);
  await click('[data-testid="company-invite-show_rooms"]');
  await waitFor(`!document.querySelector('[data-testid="company-invite-dialog"]') && (document.querySelector('[data-testid="sidebar-company-scope"]')?.textContent || '').includes('Herotel')`);
  // Opening a room outside the company switches back to All rooms, so the room never hides.
  await click('[data-testid="sidebar-new-room"]');
  await click('[data-testid="new-room-modal"] [role="tab"][id$="-tab-join"]');
  await js(`{ const input = document.querySelector('[data-testid="new-room-join-input"]'); input.value = 'github.com/alex/personal'; input.dispatchEvent(new Event('input', { bubbles: true })); }`);
  await click('[data-testid="new-room-join-submit"]');
  await waitFor(`(document.querySelector('[data-testid="sidebar-company-scope"]')?.textContent || '').trim().startsWith('Rooms') && !document.querySelector('[data-testid="company-home"]')`);
  await capture('10-explicit-personal-room.png');
  assert.deepEqual(errors, [], 'renderer must not report uncaught errors');
  const report = { passed: true, checks: ['first-run owner setup', 'member waiting for owner', 'pending GitHub invitation', 'company repo room on the room step', 'company filter on the Rooms heading', 'empty company home', 'GitHub outage and retry', 'All rooms fallback', 'company link persistence and acknowledgement', 'company link dialog over any view', 'join from a company link', 'new room inside the company', 'pasted company link', 'explicit outside-company room opens in All rooms'], consoleErrors: errors, calls: [...new Set(calls)] };
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

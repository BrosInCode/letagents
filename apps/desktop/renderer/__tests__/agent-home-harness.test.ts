import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  agentRoomAudience,
  homeHarnessApprovalNote,
  homeHarnessBadge,
  homeHarnessDescription,
  homeHarnessLimitNote,
  homeHarnessMoveNote,
  homeHarnessRestartNote,
  homeHarnessRoomNote,
  homeHarnessSavedRulesNote,
  homeHarnessTimingNote,
  homeHarnessTitle,
  homeHarnessUnavailableReason,
  ownerSetupRefusalReason,
  ownerSetupStartHint,
} from "../src/domain/agent-home-harness";
import { supervisedPermissionProfileLimits } from "../src/domain/managed-agents";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the switch names the owner's own setup for the agent's app and says what it lets the agent use", () => {
  assert.equal(homeHarnessTitle("codex"), "Use your own Codex setup");
  assert.equal(homeHarnessTitle("claude-code"), "Use your own Claude Code setup");
  for (const [provider, profile] of [["codex", "full_access"], ["codex", "ask_before_write"], ["claude-code", "ask_before_write"], ["claude-code", "auto_review"], ["claude-code", "full_access"]] as const) {
    const description = homeHarnessDescription(provider, profile);
    assert.match(description, /MCP servers, plugins/, `${provider}/${profile}`);
    assert.match(description, /skills, (commands, )?hooks/, `${provider}/${profile}`);
    assert.match(description, /Those tools act as you\./);
  }
  assert.match(homeHarnessDescription("codex"), /browser or computer control/);
  assert.match(homeHarnessDescription("claude-code", "ask_before_write"), /permission rules/);
  // A Read-only Claude agent has no tool that runs a skill, so none is promised. Read-only is also Claude's default.
  for (const profile of ["read_only", null]) {
    const readOnly = homeHarnessDescription("claude-code", profile);
    assert.match(readOnly, /your MCP servers, plugins' servers, hooks, instructions and permission rules\. Those tools act as you\. With Read-only it cannot run your skills\./);
    assert.doesNotMatch(readOnly, /plugins, skills/);
  }
  // It is the owner's setup and never the project's, and the text says what happens to a project's own.
  assert.match(homeHarnessDescription("codex"), /Servers and hooks that a project adds stay off, and the agent will not start in a project that changes your servers or brings its own Codex settings or command rules\./);
  for (const profile of ["ask_before_write", "auto_review", "read_only", null]) {
    assert.match(homeHarnessApprovalNote("claude-code", profile), /A project's own servers and settings are not loaded\./, String(profile));
  }
  assert.equal(homeHarnessApprovalNote("claude-code", "full_access"),
    "With Full access, those tools run without asking you. While this is on, the project's own Claude settings, hooks, skills, commands and MCP servers are not loaded. Its CLAUDE.md still is.");
});

test("the approval note says what each access level was seen to do with the owner's tools", () => {
  // Codex: an approval card only under Ask before writes. A tool's "read-only" label is its own server's word, and the text says so.
  assert.match(homeHarnessApprovalNote("codex", "ask_before_write"), /you approve each of those tools before it runs\. Two kinds run without asking: tools your own Codex settings already approve, and tools their own server labels read-only, which nothing checks\./);
  assert.doesNotMatch(homeHarnessApprovalNote("codex", "ask_before_write"), /only read/, "nothing implies such a tool is safe");
  assert.match(homeHarnessApprovalNote("codex", "auto_review"), /Codex decides .* You are not asked\./);
  assert.match(homeHarnessApprovalNote("codex", "full_access"), /run without asking you/);
  assert.match(homeHarnessApprovalNote("codex", null), /run without asking you/, "Codex's default is full access");
  // Claude: the owner's own rules apply first.
  assert.match(homeHarnessApprovalNote("claude-code", "ask_before_write"), /you approve each of those tools before it runs, unless your own Claude Code rules already allow it/);
  assert.match(homeHarnessApprovalNote("claude-code", "auto_review"), /Claude decides .* asks you only when it will not decide/);
  assert.match(homeHarnessApprovalNote("claude-code", "full_access"), /run without asking you/);
  assert.match(homeHarnessApprovalNote("claude-code", "read_only"), /only where your own Claude Code rules allow them\. Nothing asks you\./);
  assert.match(homeHarnessApprovalNote("claude-code", null), /Nothing asks you\./, "Claude's default is read-only");
  // No note ever promises an approval that does not come.
  for (const profile of ["auto_review", "full_access"]) {
    assert.doesNotMatch(homeHarnessApprovalNote("codex", profile), /you approve/);
  }
  assert.doesNotMatch(homeHarnessApprovalNote("claude-code", "full_access"), /you approve/);
  assert.match(homeHarnessLimitNote("codex"), /type an answer or sign in is declined/);
  assert.match(homeHarnessLimitNote("claude-code"), /type an answer is declined/);
});

test("a room that other people can reach is named, and a room nobody else has used is not called shared", () => {
  const human = (key: string, login: string | null = null, hiddenAt: string | null = null) =>
    ({ kind: "human" as const, participantKey: key, githubLogin: login, hiddenAt });
  const agent = { kind: "agent" as const, participantKey: "agent-1", githubLogin: null, hiddenAt: null };
  const agentOf = (ownerLabel: string | null, actorLabel: string | null = null, hiddenAt: string | null = null) =>
    ({ kind: "agent" as const, participantKey: `agent-${ownerLabel ?? actorLabel}`, githubLogin: null, ownerLabel, actorLabel, hiddenAt });
  const gitRoom = (accessMode: string, visibility = accessMode) => ({ gitRoom: { accessMode, visibility } }) as never;

  assert.equal(agentRoomAudience(gitRoom("public"), [human("me")]), "public");
  assert.equal(agentRoomAudience(gitRoom("unknown", "public"), []), "public");
  assert.equal(agentRoomAudience(gitRoom("private"), [human("me", "Owner"), human("you", "guest")]), "shared");
  assert.equal(agentRoomAudience({ gitRoom: null }, [human("me"), human("you")]), "shared");
  assert.equal(agentRoomAudience(gitRoom("private"), [human("me", "Owner"), human("me-again", "owner"), agent]), "private",
    "the same person twice, and agents, are not other people");
  assert.equal(agentRoomAudience(gitRoom("private"), [human("me"), human("gone", "guest", "2026-10-01T00:00:00Z")]), "private");
  assert.equal(agentRoomAudience(null, []), "private");
  assert.equal(agentRoomAudience(undefined, [human("me")]), "private");

  // Someone else's agent can message this agent too, so it counts as that person, even when they have not posted.
  const me = ["Owner", "Owner Name"];
  assert.equal(agentRoomAudience(gitRoom("private"), [human("me", "Owner"), agentOf("Guest")], me), "shared");
  assert.equal(agentRoomAudience(gitRoom("private"), [agentOf("Guest")], me), "shared");
  assert.equal(agentRoomAudience(gitRoom("private"), [human("me", "Owner"), agentOf(null, "QuartzMeadow | Guest's agent | Codex")], me), "shared",
    "the owner is read from how the room names the agent when nothing else says");
  assert.equal(agentRoomAudience(gitRoom("private"), [human("me", "Owner"), agentOf("Guest")]), "shared", "with no account to compare, two people are two people");
  // The owner's own agents are not other people, however the room spells the owner.
  assert.equal(agentRoomAudience(gitRoom("private"), [human("me", "Owner"), agentOf("owner"), agentOf("Owner's agent"), agentOf(null, "Fern | Owner Name's agent | Claude")], me), "private");
  assert.equal(agentRoomAudience(gitRoom("private"), [agentOf("Owner"), agentOf("OWNER")]), "private");
  // An agent whose owner cannot be told, or that left, is not counted as anyone.
  assert.equal(agentRoomAudience(gitRoom("private"), [human("me", "Owner"), agentOf(null), agentOf("Local desktop"), agentOf("Guest", null, "2026-10-01T00:00:00Z")], me), "private");
  // Another person is another person whether or not the account is known.
  assert.equal(agentRoomAudience(gitRoom("private"), [human("me", "Owner"), human("you", "guest")], me), "shared");
  assert.equal(agentRoomAudience(gitRoom("private"), [human("you", "guest")], me), "shared", "one other person and not the owner is still someone else");
  assert.equal(agentRoomAudience(gitRoom("public"), [], me), "public");

  assert.match(homeHarnessRoomNote("public"), /This room is public\. Anyone who can post here can ask this agent to use your tools\./);
  assert.match(homeHarnessRoomNote("shared"), /Other people are in this room\. Any of them can ask this agent to use your tools\./);
  assert.match(homeHarnessRoomNote("private"), /Anyone who can message this agent in the room can ask it to use them\./);
});

test("an agent that cannot use the owner's setup gets one line saying why, and no switch", () => {
  assert.equal(homeHarnessUnavailableReason({ availability: "available" }, "codex"), null);
  assert.match(homeHarnessUnavailableReason({ availability: "rental" }, "codex")!, /rented agent works for someone else/);
  assert.match(homeHarnessUnavailableReason({ availability: "rental" }, "cursor")!, /rented agent works for someone else/);
  for (const provider of ["codex", "claude-code"]) {
    assert.equal(homeHarnessUnavailableReason({ availability: "polling" }, provider),
      "Not available for this agent: it fetches its own messages, so LetAgents can't reliably switch your setup off again.");
  }
  assert.match(homeHarnessUnavailableReason({ availability: "unsupported" }, "cursor")!, /sealed copy of Cursor/);
  assert.match(homeHarnessUnavailableReason({ availability: "unsupported" }, "open-model")!, /LetAgents' own copy of OpenCode/);
  assert.match(homeHarnessUnavailableReason({ availability: "unsupported" }, "other")!, /no setup of yours/);
});

test("agents that use the owner's setup are marked in the inspector header and the room's agent list", () => {
  assert.deepEqual(homeHarnessBadge("codex", "on"), { label: "Your setup", title: "This agent uses your own Codex setup." });
  const surface = read("../src/components/desktop/content/agent-inspector/AgentInspectorSurface.vue");
  assert.match(surface, /<span v-if="projection\.entry\.homeHarness" class="agent-inspector-own-setup"[^>]*>\{\{ homeHarnessBadge\(projection\.provider, projection\.entry\.homeHarness\)\.label \}\}<\/span>/);
  const roster = read("../src/components/desktop/content/RoomActivityTabView.vue");
  assert.match(roster, /<span v-if="agent\.entry\.homeHarness" class="desktop-activity-mini-pill"[^>]*>\{\{ homeHarnessBadge\(agent\.provider, agent\.entry\.homeHarness\)\.label \}\}<\/span>/);
});

test("the mark says what the running agent has, and never that a change has reached an agent it has not", () => {
  // Saved on, but the running process started without it.
  assert.deepEqual(homeHarnessBadge("claude-code", "after_restart"), {
    label: "Setup pending", title: "This agent is set to use your own Claude Code setup. It gets it the next time it starts.",
  });
  // Saved off, but the running process still has it: the mark stays until it restarts.
  assert.deepEqual(homeHarnessBadge("codex", "until_restart"), {
    label: "Setup ending", title: "You turned this off, but this agent is still running with your own Codex setup. It loses it when it restarts.",
  });
  assert.notEqual(homeHarnessBadge("codex", "after_restart").label, homeHarnessBadge("codex", "on").label);
  assert.notEqual(homeHarnessBadge("codex", "until_restart").label, homeHarnessBadge("codex", "on").label);
  // Every label is short, so the agent's name keeps its room; the title carries the explanation.
  for (const state of ["on", "after_restart", "until_restart"] as const) {
    assert.ok(homeHarnessBadge("claude-code", state).label.length <= 13, state);
    assert.ok(homeHarnessBadge("claude-code", state).title.length > 30, state);
  }

  // In the settings, the same is said in a sentence.
  assert.match(homeHarnessTimingNote({ enabled: false, pending: false }), /Turning this on takes effect the next time the agent starts\. Turning it off restarts the agent straight away if it is idle\./);
  assert.match(homeHarnessTimingNote({ enabled: true, pending: false }), /Turning it off restarts the agent straight away if it is idle\./);
  assert.match(homeHarnessTimingNote({ enabled: true, pending: true }), /has not restarted since you turned this on\. It gets your setup the next time it starts\./);
  assert.match(homeHarnessTimingNote({ enabled: false, pending: true }), /If this agent is still running, it keeps your setup until it restarts\./);

  // Turning it off says what happened to the agent that was running.
  assert.deepEqual(homeHarnessRestartNote("restarting"), { text: "Restarting this agent now so it stops using your setup.", warning: false });
  assert.deepEqual(homeHarnessRestartNote("busy"), { text: "This agent is working, so it was not restarted yet. It keeps your setup until this turn ends, then restarts before it takes another.", warning: true });
  assert.deepEqual(homeHarnessRestartNote("not_restarted"), { text: "This agent was not restarted. If it is running, it keeps your setup until it restarts.", warning: true });
  assert.equal(homeHarnessRestartNote(undefined), null);
});

test("the app tells every agent's settings which room this is, who has been in it and who is signed in", () => {
  const app = read("../src/App.vue");
  assert.match(app, /provideAgentRoomAudience\(\(\) => selectedRoomWithProjectContext\.value, \(\) => selectedSnapshot\.value\?\.participants \?\? \[\], \(\) => \[authStatus\.value\?\.account\?\.login, authStatus\.value\?\.account\?\.displayName\]\);/);
  const composable = read("../src/composables/useAgentRoomAudience.ts");
  assert.match(composable, /provide\(agentRoomAudienceKey, computed\(\(\) => agentRoomAudience\(room\(\), participants\(\), viewer\(\)\)\)\);/);
  // It lives in its own module: the room shell and the inspector host carry nothing for it.
  for (const file of ["../src/components/desktop/content/DesktopRoomShell.vue", "../src/components/desktop/content/agent-inspector/AgentInspectorHost.vue"]) {
    assert.doesNotMatch(read(file), /agentRoomAudience|roomPeople/, file);
  }
});

test("an access level's limits are described truthfully for an agent that uses its owner's setup", () => {
  const limits = (provider: string, id: string, ownSetup: boolean) => supervisedPermissionProfileLimits(provider, { id: id as never, status: "available" }, ownSetup);
  // Without the owner's setup nothing changes.
  assert.equal(limits("claude-code", "ask_before_write", false), "Can't change files or run write commands until you approve each one.");
  assert.equal(supervisedPermissionProfileLimits("claude-code", { id: "ask_before_write", status: "available" }), limits("claude-code", "ask_before_write", false));
  // With it, the owner's own allow rules can let the agent act with no approval, and no line says otherwise.
  assert.equal(limits("claude-code", "ask_before_write", true), "Asks before it changes files or runs write commands, except where your own Claude Code rules already allow it. Your hooks run without asking.");
  assert.equal(limits("claude", "ask_before_write", true), limits("claude-code", "ask_before_write", true));
  assert.match(limits("claude-code", "read_only", true)!, /^Its own tools can't change files, run commands or browse the web\. Your MCP tools and hooks can, where your own Claude Code settings allow them\.$/);
  assert.match(limits("claude-code", "auto_review", true)!, /after your own Claude Code rules have allowed what they allow/);
  for (const id of ["ask_before_write", "auto_review"]) {
    assert.match(limits("codex", id, true)!, /Your own MCP tools, hooks and plugins are not held to this\.$/, id);
    assert.doesNotMatch(limits("codex", id, false)!, /Your own/, id);
  }
  for (const [provider, id] of [["claude-code", "ask_before_write"], ["claude-code", "read_only"], ["codex", "ask_before_write"]] as const) {
    assert.doesNotMatch(limits(provider, id, true)!, /^(Can't|Without your approval: no)/, `${provider}/${id}: nothing is promised that the owner's setup can undo`);
  }
  // Where nothing is withheld, or the agent app never gets the owner's setup, the line is the same.
  for (const [provider, id] of [["codex", "full_access"], ["claude-code", "full_access"], ["cursor", "sandboxed_write"], ["open-model", "ask_before_write"]] as const) {
    assert.equal(limits(provider, id, true), limits(provider, id, false), `${provider}/${id}`);
  }
  assert.equal(supervisedPermissionProfileLimits("claude-code", { id: "ask_before_write", status: "gated" }, true), null);
});

test("moving an agent and its saved tool permissions are both spoken to where the switch is on", () => {
  assert.equal(homeHarnessMoveNote("codex"), "This agent keeps using your own Codex setup after a move. Anyone who can message it in the room you move it to can ask it to use your tools. Turn that off first if you do not want it there.");
  assert.match(homeHarnessMoveNote("claude-code"), /your own Claude Code setup after a move/);
  assert.equal(homeHarnessSavedRulesNote(0), null);
  assert.equal(homeHarnessSavedRulesNote(2), "Changing this pauses the tools under Always allowed. They stay listed but stop applying, so the agent asks again. Changing it back restores them.");
});

test("every switch here is the shared switch, and the change is never part of the saved draft", () => {
  const section = read("../src/components/desktop/content/agent-inspector/AgentInspectorHomeHarness.vue");
  assert.match(section, /<DesktopSwitch\b/);
  assert.doesNotMatch(section, /type="checkbox"/);
  assert.match(section, /desktopIpc\.supervisor\?\.setAgentHomeHarness/);
  const draft = read("../src/domain/agent-inspector-settings.ts");
  assert.doesNotMatch(draft.slice(draft.indexOf("export type AgentInspectorConfigurationDraft"), draft.indexOf("export type AgentInspectorConfigurationResource")), /homeHarness/);
});

test("a start refused over the owner's setup is shown as the launch said it, and a slow start names what of the owner's held it up", () => {
  const reason = "This project's Codex config (.codex/config.toml) sets model, so LetAgents will not start Codex here with your own setup. "
    + "With your own setup on, an agent starts with your Codex settings only. Remove them from that file in the repository and commit the removal, stop trusting the project in Codex, or turn off \"Use your own Codex setup\" for this agent.";
  assert.equal(ownerSetupRefusalReason(`convergence scheduler failure: ${reason}`), reason);
  assert.equal(ownerSetupRefusalReason(reason), reason);
  // An agent that could not be restarted to end the setup: what the background service records is shown as it was said.
  const stuck = "LetAgents could not restart this agent to stop it running with your own setup, so its messages are waiting. "
    + "Pause the agent and resume it to finish switching your setup off; cause: native stop failed";
  assert.equal(ownerSetupRefusalReason(`convergence scheduler failure: ${stuck}`), stuck);
  for (const other of [null, undefined, "", "convergence scheduler failure: The saved OpenCode process is no longer running.",
    "convergence scheduler failure: Claude CLI did not report its stream-json init message (deadline). This agent starts with your own Claude Code setup, so one of your MCP servers or hooks may be holding the start up."]) {
    assert.equal(ownerSetupRefusalReason(other), null, String(other));
  }
  assert.equal(ownerSetupStartHint("… (deadline). Startup observations: budget_ms=60000. This agent starts with your own Claude Code setup, so one of your MCP servers or hooks may be holding the start up."),
    "One of your own MCP servers or hooks may be holding the start up.");
  assert.equal(ownerSetupStartHint('… (deadline). Startup observations: budget_ms=60000. Your MCP server "owner.slow" did not start, so this agent is running without it. Your MCP server "b" was still starting when this agent began, so its tools may be missing.'),
    'Your MCP server "owner.slow" did not start, so this agent is running without it. Your MCP server "b" was still starting when this agent began, so its tools may be missing.');
  assert.equal(ownerSetupStartHint("… (deadline). Startup observations: budget_ms=30000."), "");
});

# Ask for an agent

Cash App–style "please add an agent to my room". Someone you trust adds a fresh agent, on their own quota, to your room. Full decision log: `AGENT_REQUEST_UX.md` (design walkthrough, D1–D56).

## Goal

V1 works end to end on Mac, simply and reliably:

1. Sam asks from a room ("+" → Ask someone for an agent): room, model, optional amount and note → a one-use link that lasts 24 hours.
2. John taps the link. The desktop app opens on the giving screen with the requested model and amount picked. One tap: **Add Opus 5.5**.
3. The agent joins Sam's room with a short intro, works like any agent in the room, and stays inside the amount John gave.
4. It ends cleanly. Both sides always know what happened and what to do next.

Done means: the flow above works, every failure below is handled the way this file says, and tests cover the lifecycle.

## Error handling

Four rules. Everything else follows from them.

1. **The server decides.** The ask's state lives on the server. Apps show it and ask to change it. If two people act at once, the first wins and the other sees the current state.
2. **Nothing waits forever.** Every waiting state has one timeout (table below).
3. **Safety fails closed, everything else fails open.** If the folder lock or the room pass can't be set up, the agent doesn't start. Any other failure before the agent joins gives the link back, so a request is never wasted.
4. **Every message says what happened and what to do.** One sentence, no codes, shown only to the side it affects.

### Lifecycle

| State | Meaning | Times out after | Then |
|---|---|---|---|
| `open` | Link is live | 24 h from creation | `expired` |
| `claimed` | A giver tapped and is adding the agent | 15 min (renewed while they're active) | back to `open` |
| `on_hold` | A different model was added; waiting for the asker | 24 h | agent removed, back to `open` (or `expired`) |
| `active` | Agent is in the room | — (bounded by the amount) | `ended` |
| `paused` | Agent temporarily unavailable | 24 h | `ended` |
| `ended` / `expired` / `cancelled` | Final | — | — |

### What can go wrong

| When | What happens | Who sees what |
|---|---|---|
| Creating the link fails | Nothing is created | Asker: "Couldn't create the link. Try again." |
| Link expired / cancelled / used | Nothing to do | Giver: "This request expired." / "Sam cancelled this request." / "Someone already helped Sam. Thanks for offering." |
| Two givers at once | First claim wins | Second giver: "Someone is adding this agent right now." |
| Giver not signed in / provider not set up | Inline sign-in or setup, then back to the same screen | Giver only |
| Not enough quota left | Agent doesn't start, link stays open | Giver: "You have 6% of your weekly limit left. Give less or cancel." |
| Folder lock or agent start fails | Agent doesn't start, link stays open | Giver: "Your Mac couldn't start this agent. The request is still open for others." |
| Giver's Mac offline, app quit, sign-in expired, provider down | `paused`; resumes by itself when fixed | Asker: "John's agent is offline." Giver (if they can fix it): "Sign in to Claude again to continue." |
| Paused for 24 h | `ended` | Both: "John's agent was offline for a day and has left." |
| Amount used / giver hits real limit | Agent finishes its reply, says where it stopped, leaves | Asker: "John's agent used the 10% he gave." Asker can tap **Ask John for more**. |
| Asker removes the agent / deletes the room | `ended` | Giver: "Sam removed your agent." |
| Substitute not accepted in 24 h | Removed, link reopens if still valid | Asker only |
| Usage stops being reported | Keeps working; after 30 min without a reading → `paused` | Both |

Numbers: claim 15 min, offline before notice 5 min (idle agents long-poll for up to 3 min), no-usage pause 30 min, pause before end 24 h.

## Build status

**Built (branch `feat/ask-for-an-agent`):**
- Server: asks table, lifecycle with every timeout, routes, one-room ask grants, room lines, sweep on the liveness tick.
- Asker: "+" menu and `/ask`, the ask sheet with the room dropdown and new room, link card, the room bar (copy link, cancel, accept or remove a substitute, review, remove).
- Giver: `letagents://ask/…` and web links, the giving screen (requested model and amount picked, custom amount, "Can't right now"), one-tap launch as a guest agent, pre-check of the remaining limit, the amount counter across resets, ending on amount used or real limit.
- Web: `/ask/<token>` page with Open in LetAgents and the download.
- **Code access (D13):** LetAgents keeps a copy of the room's repo (GitHub App token when connected). The given agent gets `ask_list_files`, `ask_read_file`, `ask_search`, `ask_propose_change`; every read passes the secret firewall and is recorded for "Files seen". The asker reviews proposals and approves them into one stacked PR. No commands run on LetAgents' servers.
- **Givable providers:** Cursor (its verified sandbox), **Claude Code** (no built-in tools at all, only LetAgents tools; checked at spawn and against Claude's own startup report) and **Codex** (Read-only, with shell, image, web, app and owner MCP tools switched off; each launch first asks this exact Codex, with the agent's model, which tools it would offer, via a local fake model server, and refuses on anything else. Confirmed with a real turn on a code-mode model: it could not read a file in the giver's home).

**Not built yet:**
1. **Ask for more (D38), Ask again (F6), goodbye summary (F8), first-time explainers (F11), the "Asked and given" inbox list (F5).**
2. **The 30-minute no-usage pause** and the giver's "Sign in to Claude again" notice.
3. **Running commands** (tests, builds) for the given agent: a separate decision, since they would run the asker's code on LetAgents' servers.
4. A full manual run in the app with two accounts.

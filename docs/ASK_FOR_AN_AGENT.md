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

Numbers: claim 15 min, offline before notice 2 min, no-usage pause 30 min, pause before end 24 h.

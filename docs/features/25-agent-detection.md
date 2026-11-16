# 25 · Agent detection in terminals

## Context

Coding agents (Claude Code, Codex, Gemini, OpenCode, Kimi, Grok, Cursor,
Copilot, Qwen, Amp, …) run in terminals on several machines at once, and
the user's attention goes to the ones that wait for an answer or finished
a turn ([07](07-agent-native-workflow.md)). The terminal multiplexer herdr
tells this for its own panes. The terminal core ([21](21-terminal-core.md))
does not: a terminal's status there is only what its program reports
through OSC 7501, and the agents above report nothing. So the terminals of
the terminal core get herdr's detection, done next to them.

herdr's method (herdr v0.9.5, `src/detect`, `src/pane/agent_detection.rs`,
Apache-2.0):

- **Which agent** comes from the foreground process of the terminal: its
  name or `argv[0]`, lowercased, without a path or a Windows or script
  extension, looked up in a table of names and aliases (`claude`,
  `claude-code`, `cursor-agent`, …); a shell or a runtime (`sh`, `bash`,
  `node`, `bun`, `python3.12`, …) running a script counts as the script's
  agent unless it runs inline code (`-c`, `-e`, `-m`); some agents are
  recognized by their package's entry point (`…/@qwen-code/qwen-code/dist/index.js`).
- **What it does** comes from the screen, through a manifest per agent:
  ordered rules, each with a state (`working`, `blocked`, `idle`,
  `unknown`), a priority, a region of the screen and a gate. Regions are
  the whole screen, its bottom or top N (non-empty) lines, the body of the
  prompt box between the last two horizontal rules, what follows the last
  horizontal rule, Codex's prompt markers, or the terminal's title (OSC 0/2)
  and progress report (OSC 9;4). A gate matches when every `contains`
  (case-insensitive) is in the region, every `regex` matches it, every
  `line_regex` matches one of its lines, every gate of `all` and one of
  `any` match, and none of `not`. Of the matching rules the one with the
  highest priority wins (the first one among equals); none matching reads
  idle. A rule may mark the screen as an agent's own viewer
  (`skip_state_update`: its transcript), which keeps the previous state,
  and rules carry whether they saw live chrome (`visible_idle`,
  `visible_blocker`, `visible_working`).
- **When** the screen is read: after output, at most every 300 ms; not
  during the 3 s after an agent appeared (its splash or the shell's last
  screen). A change from working to idle without visible idle chrome is
  held until three more reads 100 ms apart agree, or for at most 700 ms: a
  spinner between two frames reads as idle.
- **Done** is a turn that ended: working or blocked became idle, also when
  the agent left the foreground in the middle of a turn. It stays until the
  user looks at the terminal, and a turn that ends while the user looks at
  it is idle at once.

## Goals / non-goals

Goals: the same identification, rules, timing and done for the terminal
core's terminals, so the rules herdr maintains carry over unchanged; a
status the program reports itself (OSC 7501) taking precedence; the
result in the terminal records clients already follow and in the `/ws`
agent message that notifications and sounds use; nothing running for
terminals nobody follows.

Non-goals: herdr's hooks and plugin integrations (an agent reporting its
lifecycle through herdr's API), updating manifests from the network, local
manifest overrides, Windows processes; interpreting agent output beyond
the state.

## Design

**Package** `internal/agent/detect`:

- `manifests/*.toml` are herdr v0.9.5's manifests, unchanged, embedded
  (22 agents; [licenses/herdr-detect](../../licenses/herdr-detect/README.md)).
  `Parse` reads herdr's format strictly (unknown fields refused) and checks
  herdr's limits (at most 128 rules, gates 8 deep, 512 gates, 32 matchers a
  gate, 1024 in all, 512 characters a matcher, a positive matcher in every
  gate, known regions, `skip_state_update` only on `unknown` rules).
  Regular expressions are Rust's syntax; the few spellings Go's RE2 writes
  differently (`\uXXXX`, `\u{X}`, `\p{Alphabetic}`) are rewritten when the
  rule is compiled. `Evaluate` cuts the regions as herdr does and applies
  the rules.
- `Identify(name, argv)` names the agent of a foreground process as above.
- `Tracker` is one agent's state machine: the startup grace, the idle
  confirmation, done, and the program's own report (OSC 7501: `idle`,
  `working`, `blocked`, `done`, `error` read as blocked), which applies at
  once and stops screen reads while it stands.

**In the agent** (`internal/agent/agentdetect.go`, op `detect`). The core
opens the stream when its connection to the machine's terminal core is
ready ([22](22-terminal-protocol.md)) and keeps it while that connection
lasts, which is while a client follows the machine's terminals. The agent
then connects to the terminal core itself, subscribes to its events and
follows each terminal's record (foreground process, title, size, the
program's status). For a terminal whose foreground is an agent it
attaches as an observer, whose output only says that the screen changed
(the bytes are acknowledged and dropped), and reads the screen with
`terminal.read` when needed. Each change goes to the core as one line
`{terminal, agent, status}`; an agent that leaves sends `{terminal}`.

**In the core** (`internal/server/term.go`). The backend keeps the agents
per terminal, merges them into the terminal records as `agent` and
`agent_status` (snapshots for later subscribers included) and sends
subscribers an `event {type: "agent", terminal, data: {agent,
agent_status}}` (both null when the agent left); after an event that
replaces a record (`created`, `restarted`, `labels`) the agent event is
sent again. `/ws` clients get the agent message
`agent {m, data: {terminal, agent, display_agent, agent_status, title},
sound}`, with the same choice of the page that plays the sound
([07](07-agent-native-workflow.md)). A client's `focus {s, focused: true}`
on a stream of the terminal marks a `done` seen (`idle`); a `done` arriving
while a client has the terminal focused is reported idle. A program that
reports its own status (Codex does, with OSC 7501) keeps saying `done`
until its next turn, and the terminal core keeps that report: after the
core or the agent starts again (the desktop app restarted), a new
detection reads it as a turn that just ended. So while the core holds such
a `done` seen, it labels the terminal `seen` with the record's turn (which
goes up each time the status leaves `working`; `terminal.label`, which
keeps the other labels), and the first word of a new detection that is
the `done` of that turn is idle. A later turn's `done` is news, and a
`done` read from the screen is never taken for seen.

**Client.** The web UI reads a terminal's state from `agent_status`, else
from the program's own status (OSC 7501), and its agent from `agent`
(`web/src/lib/machine.ts`: `agentStatus`, `agentOf`; a program's own
`error` reads as blocked). It colors the panes', tabs' and the sidebar's
status dots, orders the attention inbox blocked, done, working, idle
(`attentionList` in `web/src/actions.ts`), and notifies and plays sounds
from the `/ws` agent message (`notify.ts`, `sound.ts`,
[07](07-agent-native-workflow.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| Detection in the core | Every screen read would cross the ssh connection; the agent reads next to the terminal core, and only state changes travel. |
| Rules of our own | herdr's rules follow each agent's releases; the same format and files carry over with every herdr release. |
| A TOML-free format (JSON) for the manifests | They would have to be converted, and updated by hand, at every herdr release. |
| Polling every agent terminal's screen on a timer | Reads the screens of idle agents for nothing; the observing attach tells when output arrived, as herdr's content counter does. |
| Reading the attach stream's bytes with a terminal emulator in the agent | A second emulator per terminal on every machine; `terminal.read` returns the terminal core's own screen. |
| Detection in each client | Every client would read every screen, and `done` would differ between them. |
| Marking done seen when a client attaches | A client attaches to every pane it shows, also in tabs the user does not look at; focus is what herdr goes by. |

## Failure modes

- **An agent's interface changes** → its rules stop matching: it reads
  idle, or a wrong state, until herdr's manifests (and this copy) follow.
- **An agent not in the table** (renamed, wrapped in an unknown launcher)
  → no agent and no status; the program's own OSC 7501 report still shows.
- **An agent without a manifest** (`omp`, `mastracode`: herdr follows them
  through hooks) → named, status `unknown` unless the program reports one.
- **The detect stream ends** (agent or terminal core gone) → the core
  clears every agent of the machine and opens a new stream after 5 s while
  its connection lasts; the new stream reports the agents again (a
  program's reported `done` of a turn labeled `seen` as idle).
- **The `seen` label cannot be set** (the terminal core refused or went
  away) → logged; after a restart that turn's `done` is news once more.
- **A terminal the observer cannot attach to** → its screen is read every
  300 ms.
- **Screen reads fail** (the terminal ended meanwhile) → the next event
  ends the agent.

## Security

The agent reads the screens of the user's own terminals in its own terminal
core, as the user, and sends only an agent name and a state word to the
core; no screen text leaves the machine through this path. See the row for
agent detection in [SECURITY.md](../../SECURITY.md).

## Testing

`internal/agent/detect/detect_test.go`: every embedded manifest loads;
screens of the agents the palette starts (Claude Code, Codex, Gemini,
OpenCode, Kimi, Grok, Cursor, Copilot, Qwen, Amp) give working, blocked and
idle, Claude Code's transcript viewer is skipped, titles count; gate
semantics, priorities, the idle fallback and refused manifests; every
region; the regex rewriting; identification of names, aliases, paths,
wrapped scripts, package entry points and inline code; the startup grace,
the idle confirmation and its cap, done after working and after blocked,
done on exit, precedence and clearing of the program's own report.
`internal/server/term_test.go` (`TestTermAgents`): records, events, `/ws`
messages, done seen by focus, cleared agents; `TestTermSeenTurnOutlivesTheCore`:
a program's reported done of the turn labeled `seen` is idle after a
restart, a later turn's is news until focused, which labels its turn, and
a done read from the screen is never seen. `TestIntegrationDetect`
(`make it`, `HC_TEST_BIN`) runs a script named `claude` in a real
herdr-core that shows a turn, a permission dialog and its prompt, and
follows working, blocked and done through the agent to `/api/v1/term` and
`/ws`. The web UI's side: `web/src/__tests__/terms.test.ts` (agents
listed by how much they need the user) and `sound.test.ts`.

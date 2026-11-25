# 25 · Agent detection in terminals

## Context

Coding agents (Claude Code, Codex, Gemini, OpenCode, Kimi, Grok, Cursor,
Copilot, Qwen, Amp, …) run in terminals on several machines, and the
user's attention goes to the ones waiting for an answer or done with a turn
([07](07-agent-native-workflow.md)). The terminal core
([21](21-terminal-core.md)) knows only what a program reports through OSC
7501, and most agents report nothing. The terminal multiplexer herdr
detects agents in its panes; this feature applies herdr's method (v0.9.5,
Apache-2.0) to the terminal core's terminals.

herdr's method:

- **Which agent**: the terminal's foreground process name or `argv[0]`,
  normalized and looked up in a table of names and aliases. A shell or
  runtime (`node`, `python3.12`, …) running a script counts as the
  script's agent, unless it runs inline code (`-c`, `-e`, `-m`).
- **What it does**: a manifest per agent of ordered rules, each with a
  state (`working`, `blocked`, `idle`, `unknown`), a priority, a region of
  the screen (bottom lines, the prompt box, the title, OSC 9;4 progress,
  …) and a gate of `contains`/`regex`/`all`/`any`/`not` matchers. The
  highest-priority matching rule wins; none reads idle. A rule may mark a
  screen as the agent's own viewer (`skip_state_update`), keeping the
  previous state.
- **When**: after output, at most every 300 ms, not during the first 3 s
  after an agent appears. Working→idle without visible idle chrome needs
  confirming reads (100 ms apart, at most 700 ms), since a spinner between
  frames reads idle.
- **Done**: a turn that ended (working or blocked became idle, or the
  agent left mid-turn). It stays until the user looks at the terminal; a
  turn that ends while the user looks is idle at once.

## Goals / non-goals

Goals: the same identification, rules, timing and done, so herdr's
maintained rules carry over unchanged; a program's own OSC 7501 status
taking precedence; results in the terminal records clients already follow
and in the `/ws` agent message used for notifications; nothing running for
terminals nobody follows.

Non-goals: herdr's hooks and plugin integrations; fetching manifests from
the network or local overrides; Windows processes; interpreting output
beyond the state.

## Design

**`backend/features/agents/machine/detect`** (the machine side,
[42](42-typescript-backend.md)).

- `manifests/*.toml`: herdr's 22 manifests, unchanged and embedded
  ([licenses/herdr-detect](../../licenses/herdr-detect/README.md)). The
  parser is strict and enforces herdr's limits. Rust regex spellings that RE2 lacks (`\uXXXX`, `\u{X}`,
  `\p{Alphabetic}`) are rewritten at compile time. The regular expressions
  run as RE2 with re2js (a port of RE2 with Go's syntax and semantics,
  linear in time), as the Go program of earlier releases ran them. The
  TOML is read with Bun's parser and checked against what the manifests parse to (`testdata/manifests.json`;
  `UPDATE_TESTDATA=1 bun test features/agents/machine/detect`, in
  `backend/`, rewrites it after a deliberate change: review the diff).
- Identification (`Identify`, `identify.ts`) names the agent of a
  foreground process.
- The tracker is one agent's state machine: startup grace, idle
  confirmation, done, and the program's own report (OSC 7501; `error`
  reads as blocked), which applies at once and suspends screen reads.
- `testdata/`: the screens of the common agents, identifications, regions,
  gate semantics and refused manifests, which the tests run.

**In the agent** (op `detect`: `backend/features/agents/machine/detect.ts`
and `detector.ts`, the op a feature's machine side serves). The hub
opens the stream while its backend connection for the machine is up
([22](22-terminal-protocol.md)), i.e. while some client follows the
machine. The agent subscribes to the terminal core's events and follows
each record (foreground process, title, size, status). For an agent
terminal it attaches as an observer, using output only as a "screen
changed" signal (bytes acknowledged and dropped), and reads the screen
with `terminal.read`. It sends the hub one line per change, in order,
`{terminal, agent, status}`, or `{terminal}` when the agent left. The
product's hidden terminals (the chat host's, `agentproto.Hidden`,
[22](22-terminal-protocol.md)) are not watched; the agents a chat host runs
have no terminal and report through it ([37](37-agent-chats.md)).

**Sessions.** While the agents plugin is on, the hub sets
`Header.Sessions` when it opens the stream, and the agent also finds the
session each Claude Code or Codex runs (`backend/machine/agents`; how:
[35](35-agent-native-view.md)). Switching
the plugin reopens the stream, so the agents are detected again; without
the header no session file is read. One follower per agent resolves
sessions with backoff while none is found, and again when the session
files, the foreground pid or its command line change (Claude Code's
`/clear` starts a new session), one resolution at a time within 10 s. Each
line carries the last session found as `session` and `session_source`. A
guess (the directory's newest transcript) is never taken while another
terminal runs the same kind of agent in that directory.

**In the hub** (`backend/features/terminals/agents.ts`). The backend
merges the agents into records as `agent` and `agent_status` and sends `agent`
events; `/ws` clients get `agent {m, data, sound}`
([07](07-agent-native-workflow.md)). A client's `focus` on the terminal
marks `done` seen (`idle`). The hub accepts a session only as a
lower-case UUID with a known source (`checkSession`), keeps it as
`agent_session` and `agent_session_source`, and sends both in every
`agent` event, null when unknown ([22](22-terminal-protocol.md)). A change
of the session alone is no news: no `/ws` message, sound or notification.
After the stream reopens (plugin switched), a state the clients were
already told of within 10 s is not notified twice.

A program that reports its own `done` (Codex) keeps reporting it until its
next turn, so after a hub or agent restart a fresh detection would see
the old turn as new. The hub therefore labels a terminal `seen` with the
record's turn number when its `done` is seen, and a new detection's first
`done` of that same turn is reported idle. A `done` read from the screen
is never taken for seen.

**Client.** The web UI reads `agent_status`, else the program's own status
(`web/src/lib/machine.ts`), colors status dots, orders the attention inbox
blocked, done, working, idle (`attentionList` in `web/src/actions.ts`),
and notifies and plays sounds from `/ws` ([07](07-agent-native-workflow.md)).
The detected agent, and its session unless guessed, is remembered in
the layout leaf so `claude` and `codex` can resume after a terminal core restart
([33](33-workspace-restore.md)); the session also feeds the status bar's
session usage ([29](29-ai-usage.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| Detection in the hub | Every screen read would cross ssh; next to the terminal core only state changes travel. |
| Rules of our own | herdr's rules follow each agent's releases; same format and files carry over. |
| Converting manifests to JSON | Manual conversion at every herdr release. |
| Polling every agent screen on a timer | Reads idle screens for nothing; the observer attach says when output arrived. |
| An emulator per terminal in the agent | A second emulator per terminal; `terminal.read` returns the terminal core's own screen. |
| Detection in each client | Every client reads every screen and `done` would differ between them. |
| Marking done seen on attach | Clients attach to every shown pane, including unwatched tabs; focus is what herdr uses. |

## Failure modes

- **An agent's interface changes** → its rules stop matching (idle or a
  wrong state) until herdr's manifests follow.
- **Unknown agent or launcher** → no agent; OSC 7501 still shows.
- **Agent without a manifest** (herdr follows it through hooks) → named,
  status `unknown`.
- **Detect stream ends** → the hub clears the machine's agents and
  reopens after 5 s while its connection lasts.
- **`seen` label cannot be set** → logged; after a restart that `done`
  shows as news once more.
- **Observer cannot attach** → the screen is polled every 300 ms.
- **No session found** → lines carry none: e.g. a Claude Code child
  session (`CLAUDE_CODE_CHILD_SESSION`) keeps no transcript, Codex has
  none before its first prompt, and on macOS another process's environment
  and open files are not readable ([35](35-agent-native-view.md)).

## Security

The agent reads the user's own terminals' screens, as the user, and sends
only an agent name and a state word to the hub, plus the session's id
and source word while the agents plugin is on; no screen text or path
leaves the machine through this path. See [SECURITY.md](../../SECURITY.md).

## Testing

- `backend/features/agents/machine/detect/detect.test.ts`: every manifest
  loads and parses to `testdata/manifests.json`; the cases of `testdata/` (screens
  of the common agents giving working, blocked and idle; gates, regions,
  regex rewriting, identification); RE2's semantics;
  the tracker's timing and done.
- `backend/features/agents/machine/detector.test.ts` (the tracker's
  cases on a fake clock, hidden terminals skipped) and `machine.test.ts` (op `detect` through the
  wire against a fake terminal core: sessions only when asked, the
  terminal core's events in order, the screen read without history lines,
  the stream ending with the hub's close and with the terminal core's
  silence).
- `backend/machine/agents/sessions.test.ts`: how a session is found and
  resolved.
- `backend/features/terminals/terminals.test.ts`: `agents` (`records,
  events and /ws`, `a seen turn outlives the hub`); `sessions.test.ts`:
  sessions in records and events (`agent sessions`), the header following
  the plugin (`sessions from the machine`), a session ending (`a session
  ends`), no double notification after a switch (`detected again after a
  switch`, `a switch notifies once`).
- `backend/features/terminals/integration.test.ts` (`agent detection`,
  `make it`): a fake `claude` in a real herdr-core followed through to
  `/api/v1/term` and `/ws`; `backend/features/agents/integration.test.ts`
  (`make it`): `detect` on a real herdr-core, with the
  fake `claude`'s session found from its record and resolved.
- `e2e/tests/attention.spec.ts`: a fake `claude` in a terminal draws
  attention while blocked, its session found and confirmed for a resume.
- `web/src/__tests__/terms.test.ts`, `sound.test.ts`.

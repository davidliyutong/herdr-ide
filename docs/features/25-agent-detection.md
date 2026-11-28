# 25 · Agent detection in terminals

## Context

The user's attention goes to the coding agents in terminals that wait for an answer or are done with a turn ([07](07-agent-native-workflow.md)), but the terminal core ([21](21-terminal-core.md)) knows only what a program reports through OSC 7501, and most agents report nothing. The terminal multiplexer herdr (Apache-2.0) detects agents in its panes; this feature applies its method to the terminal core's terminals. The agent is named by the foreground process (a shell or runtime running a script counts as the script's agent). Its state (`working`, `blocked`, `idle`, `unknown`) is read from the screen by a manifest per agent of prioritized rules over regions of the screen, after output, rate-limited, with working→idle confirmed by repeated reads since a spinner between frames reads idle. A turn that ended is `done` until the user looks at the terminal.

## Goals / non-goals

Goals: herdr's identification, rules, timing and done, so its maintained rules carry over unchanged; a program's own OSC 7501 status first; results in the terminal records and the `/ws` agent message; nothing running for terminals nobody follows.

Non-goals: herdr's hooks and plugin integrations; manifests from the network or local overrides; Windows processes; interpreting output beyond the state.

## Design

**The rules** (`backend/features/agents/machine/detect`): herdr's manifests (`manifests/*.toml`), unchanged and embedded ([licenses/herdr-detect](../../licenses/herdr-detect/README.md)), parsed strictly within herdr's limits, their expressions run as RE2 (re2js, linear time) with Rust-only spellings rewritten; what they parse to is held to `testdata/manifests.json` ([AGENTS.md](../../AGENTS.md), gotchas). `identify.ts` names the agent of a process; `tracker.ts` is one agent's state machine, in which the program's own report applies at once (`error` reads as blocked) and suspends screen reads.

**In the agent** (op `detect`, `backend/features/agents/machine/detector.ts`), open while some client follows the machine ([22](22-terminal-protocol.md)): the agent attaches to an agent terminal as an observer whose output only schedules a `terminal.read`, and sends the hub one line per change, `{terminal, agent, status}`. Hidden terminals are skipped; a chat's agents report through the chat host ([37](37-agent-chats.md)). While the agents plugin is on, each line also carries the agent's session ([35](35-agent-native-view.md)).

**In the hub** (`backend/features/terminals/agents.ts`): agents go into the terminal records as `agent` and `agent_status`, and to `/ws` clients as `agent {m, data, sound}` ([07](07-agent-native-workflow.md)). A client's focus on the terminal marks `done` seen (`idle`). A program that reports its own `done` (Codex) keeps reporting it until its next turn, so the hub labels a terminal `seen` with the record's turn number, and a new detection after a restart does not take that turn for news. A state the clients were already told of is not notified again when the stream reopens, nor is a change of the session alone.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Detection in the hub | Every screen read would cross ssh; next to the terminal core only state changes travel. |
| Rules of our own, or herdr's converted | herdr's rules follow each agent's releases; the same files carry over without conversion. |
| Detection in each client | Every client reads every screen, and `done` would differ between them. |
| Marking done seen on attach | Clients attach to every shown pane, including unwatched tabs; focus is what herdr uses. |

## Failure modes

- **An agent's interface changes** → its rules stop matching until herdr's manifests follow.
- **Unknown agent or launcher** → no agent; OSC 7501 still shows. **No manifest** → named, status `unknown`.
- **Detect stream ends** → the hub clears the machine's agents and reopens it with backoff.
- **Observer cannot attach** → the screen is read on every poll.

## Security

The agent reads the user's own terminals' screens, as the user, and sends only an agent name and a state word to the hub, plus the session's id and source word while the agents plugin is on; no screen text or path leaves the machine through this path. See [SECURITY.md](../../SECURITY.md).

## Testing

- `backend/features/agents/machine/detect/detect.test.ts` (manifests, the screens of `testdata/`, the tracker), `backend/features/agents/machine/detector.test.ts` and `machine.test.ts` (the op on a fake clock and terminal core).
- `backend/features/terminals/terminals.test.ts` (`agents`), `sessions.test.ts`: records, `/ws`, seen turns.
- A fake `claude` in a real herdr-core: `make it` (`backend/features/terminals/integration.test.ts`, `backend/features/agents/integration.test.ts`), `e2e/tests/attention.spec.ts`.

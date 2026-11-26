# Chat protocol recordings

Recordings of coding agents driven headless over their own protocols, one JSON object per line, for the chat host's adapters (`backend/features/chat/machine`) and the web UI's tests. Every line is `{"dir", "t", "msg"}`: `dir` tells who wrote it, as each recording's driver saw it (in `claude/`, `out` is what the agent wrote and `in` what the client sent; in `codex/` and `acp/`, `out` is what the client sent and `in` what the agent wrote); `t` is milliseconds since the file's first message; `msg` is the message as it went over the wire.

They were recorded on 2026-11-22 against the user's own sign-ins and sanitized: the working directory is `/work`, the home directory `/home/user`, the account `user@example.com` of `Example Org`; session, message, tool call, request and agent ids are stable fake ids per file; thinking signatures and base64 longer than 200 characters are placeholders; the user's own skills, commands, custom agents and MCP servers (their names, tools, commands and addresses) are placeholders (`user-skill-N`, `mcp-command-N`, `custom-agent-N`, `mcp__serverN__toolM`, `mcp-server-N`, `mcp-server-N__tool-M`) with their descriptions replaced. The rest is as the agents sent it.

## `claude/`: Claude Code 2.1.330, SDK protocol

The CLI started as the TypeScript Agent SDK 0.3.323 starts it (`--output-format stream-json --verbose --input-format stream-json --include-partial-messages --permission-prompt-tool stdio`), with `--setting-sources=user,project,local` and the model `haiku` (`claude-haiku-5-5`; plan mode ran on `claude-sonnet-5-5`).

| File | Shows |
| --- | --- |
| `claude-01-initialize.jsonl` | The `initialize` control request and its answer (commands, agents, models with their effort levels, account), SessionStart hook frames before it, `commands_changed` after. |
| `claude-02-text-turn.jsonl` | A text turn: `session_state_changed`, `command_lifecycle`, `system/init`, `rate_limit_event`, stream events (thinking, text deltas), one `assistant` frame per content block, `result` with cost and usage. |
| `claude-03-permissions.jsonl` | `can_use_tool` for a Bash command with its permission suggestions: allowed once, denied, allowed for the session. |
| `claude-03x-permissions-readonly-echo.jsonl` | A read-only command that runs without asking. |
| `claude-04-ask-user-question.jsonl` | AskUserQuestion through `can_use_tool`: answered, and skipped (denied). |
| `claude-05-plan-mode.jsonl` | `set_permission_mode plan`, the plan written, ExitPlanMode approved, the mode back to default, then `acceptEdits`. |
| `claude-06-controls.jsonl` | `get_context_usage`, `set_model`, `list_models`, `apply_flag_settings` (effort). |
| `claude-07-interrupt.jsonl` | `interrupt` while text streams: the aborted message and the error result. |
| `claude-07b-interrupt-pending-permission.jsonl` | `interrupt` while a permission waits: `control_cancel_request` for it. |
| `claude-08-queue.jsonl` | Messages sent during a turn, coalesced into the next turn; `cancel_async_message`. |
| `claude-08b-queue-midturn.jsonl` | A message sent during a tool call, taken into the running turn. |
| `claude-09-compact.jsonl` | `/compact`: status compacting, `compact_boundary`, the summary, the result. |
| `claude-10-image.jsonl` | A prompt with a base64 image block and text. |
| `claude-11-subagent.jsonl` | The Agent tool: `task_*` frames and the subagent's frames with `parent_tool_use_id`. |
| `claude-11b-subagent-permission.jsonl` | A subagent's `can_use_tool` (with `agent_id`). |
| `claude-12-resume.jsonl` | `--resume`: nothing replayed; new turns; cost continues. |
| `claude-13-entrypoint-custom.jsonl` | A resumed session with a custom `CLAUDE_CODE_ENTRYPOINT`. |
| `claude-transcript-headless.jsonl` | The lines of a headless session's transcript file (`~/.claude/projects`) that its parser reads: no `turn_duration` lines, queued commands without an origin. |

## `codex/`: Codex 0.171.0, `codex app-server --listen stdio://`

Protocol v2 with `experimentalApi`, the model `gpt-6-luna`, effort `low` unless a file says otherwise. One file per app-server process; a scenario in two processes is `.1` and `.2`.

| File | Shows |
| --- | --- |
| `01-handshake.jsonl` | `initialize` (with `requestAttestation: false`), the notifications that come unasked, `model/list`, the account and its rate limits. |
| `03-thread-text.jsonl` | `thread/start` and a text turn: item and delta notifications, token usage, `turn/completed`. |
| `04b-reasoning.jsonl` | A turn with reasoning items and their deltas. |
| `05a-command-sandboxed.jsonl` | A command under the read-only sandbox that fails without asking. |
| `05b-command-approval.jsonl` | `item/commandExecution/requestApproval`: declined, accepted for the session. |
| `06-file-change.jsonl` | File changes: applied under workspace-write, `item/fileChange/requestApproval` under read-only, `turn/diff/updated`. |
| `07-plan-and-question.jsonl` | Plan collaboration mode: the `plan` item streamed, `item/tool/requestUserInput` answered, the plan implemented in default mode. |
| `09-interrupt.jsonl` | `turn/interrupt`: the turn completes interrupted; the running command never completes. |
| `10-steer.jsonl` | `turn/steer`: a message taken into the running turn. |
| `11-compact.jsonl` | `thread/compact/start`: its own turn with a `contextCompaction` item. |
| `12-images.jsonl` | Images as a data URL and as `localImage`. |
| `13-resume.1.jsonl` | A thread with turns, before its app-server was killed. |
| `13-resume.2.jsonl` | Another app-server: `thread/list`, `thread/turns/list`, `thread/resume` with `excludeTurns`, a new turn. |
| `14-subagent.jsonl` | A subagent: `subAgentActivity` items, the `wait` `collabAgentToolCall`, the child thread's notifications on the same connection. |
| `15-errors.1.jsonl` | Errors: before `initialize`, again, unknown methods and values, unknown threads. |
| `15-errors.2.jsonl` | Errors of experimental methods without `experimentalApi`. |
| `16-trust-write-isolated-home.jsonl` | In an isolated `CODEX_HOME` without a sign-in: `thread/start` read-only and a turn with a workspace-write policy (which write no trust into `config.toml`), then `thread/start` workspace-write (which does), and the turn's `error` notifications. |

## `acp/`: Agent Client Protocol v1 over stdio

The client advertised no file system and no terminal (`clientCapabilities {fs: {readTextFile: false, writeTextFile: false}, terminal: false}`). Each agent's directory has the same scenarios.

- `kimi/`: Kimi Code 2.7.2, `kimi acp`, the model `kimi-code/k3.1-pro`, thinking `max`.
- `grok/`: Grok 1.0.92, `grok agent --no-leader stdio`, the model `grok-4.7`, effort `high`. The user's configuration approves everything: the `-always-approve` files show that; the others started their session with `_meta: {"yoloMode": false}` (`02-session-new-yolo-off.jsonl`).

| File | Shows |
| --- | --- |
| `01-initialize.jsonl` | `initialize`: capabilities, auth methods, agent info; Grok's vendor notifications. |
| `02-session-new.jsonl` | `session/new`: the session id, configuration options (model, effort, mode), Kimi's legacy modes, the commands. |
| `03-prompt-hi.jsonl` | A text turn: message and thought chunks, usage, the stop reason. |
| `04-permission-write.jsonl` | `session/request_permission` for writing a file, allowed. |
| `05-execute-permission.jsonl`, `05c-execute-permission.jsonl` | `session/request_permission` for a command, allowed; its output as text content. |
| `05-execute-read-only-auto-allowed.jsonl`, `05b-execute-mkdir-auto-allowed.jsonl` | Commands Grok runs without asking even with approval on. |
| `04-write-always-approve.jsonl`, `05-execute-always-approve.jsonl` | Grok writing and running without asking under the user's always-approve. |
| `06-set-mode-and-config-option.jsonl`, `06-set-config-option-effort.jsonl` | `session/set_mode` and `session/set_config_option`, and their update notifications. |
| `07-cancel.jsonl` | `session/cancel` during a turn: stop reason `cancelled`. |
| `08-image.jsonl`, `08-image-8px-dropped.jsonl`, `08b-image-32px.jsonl` | Image prompts: answered; Grok dropping an image below 512 pixels. |
| `09-list-load.jsonl` | `session/list` and `session/load`, which replays the whole conversation before its answer. |
| `09b-prompt-after-load.jsonl` | A turn after a load. |
| `10-resume.jsonl` | `session/resume`, which replays nothing, and a turn. |

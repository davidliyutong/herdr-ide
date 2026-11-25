// The machine sides of the features this build serves, and the chat host's
// adapters. The features whose machine side is not here yet (gui) are
// refused as an unknown plugin is (machine/agent.ts).
import type { MachineSide } from '#machine/feature.ts';
import { agentsMachine } from '#features/agents/machine.ts';
import { browserMachine } from '#features/browser/machine.ts';
import { chatMachine } from '#features/chat/machine.ts';
import { acpAdapter } from '#features/chat/machine/acp/adapter.ts';
import type { Adapters } from '#features/chat/machine/adapter.ts';
import { Adapter } from '#shared/agents/kinds.ts';
import { filesMachine } from '#features/files/machine.ts';
import { gitMachine } from '#features/git/machine.ts';
import { historyMachine } from '#features/history/machine.ts';
import { monitorMachine } from '#features/monitor/machine.ts';
import { searchMachine } from '#features/search/machine.ts';
import { usageMachine } from '#features/usage/machine.ts';
import { vscodeMachine } from '#features/vscode/machine.ts';

export function machineFeatures(): MachineSide[] {
  return [
    filesMachine(),
    gitMachine(),
    searchMachine(),
    browserMachine(),
    monitorMachine(),
    historyMachine(),
    agentsMachine(),
    usageMachine(),
    vscodeMachine(),
    chatMachine(),
  ] as MachineSide[];
}

/** The chat host's adapters, by the names of the kinds' chat specs
 * (#shared/agents/kinds.ts ADAPTERS): the Agent Client Protocol's (Kimi
 * Code, Grok). Claude Code's and Codex's are not ported yet: the host
 * refuses a chat of those kinds as one of a kind without a chat
 * (unsupported, "this host has no adapter claude"), and lists them as
 * unsupported. */
export function chatAdapters(): Adapters {
  return { [Adapter.ACP]: acpAdapter() };
}

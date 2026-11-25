// The machine sides of the features this build serves, and the chat host's
// adapters. An op or plugin no feature serves is refused as an unknown
// plugin is (machine/agent.ts).
import type { MachineSide } from '#machine/feature.ts';
import { agentsMachine } from '#features/agents/machine.ts';
import { browserMachine } from '#features/browser/machine.ts';
import { chatMachine } from '#features/chat/machine.ts';
import { acpAdapter } from '#features/chat/machine/acp/adapter.ts';
import type { Adapters } from '#features/chat/machine/adapter.ts';
import { codexAdapter } from '#features/chat/machine/codex/adapter.ts';
import { Adapter } from '#shared/agents/kinds.ts';
import { filesMachine } from '#features/files/machine.ts';
import { gitMachine } from '#features/git/machine.ts';
import { guiMachine } from '#features/gui/machine.ts';
import { historyMachine } from '#features/history/machine.ts';
import { monitorMachine } from '#features/monitor/machine.ts';
import { searchMachine } from '#features/search/machine.ts';
import { usageMachine } from '#features/usage/machine.ts';
import { vscodeMachine } from '#features/vscode/machine.ts';
import { carriedEncoder, carriedGPUPick, carriedGUIHelper } from './carried.ts';

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
    guiMachine({
      helper: async () => {
        const h = await carriedGUIHelper();
        return h && { bytes: h.bytes, digest: h.digest };
      },
      pick: carriedGPUPick,
      encoder: carriedEncoder,
    }),
  ] as MachineSide[];
}

/** The chat host's adapters, by the names of the kinds' chat specs
 * (#shared/agents/kinds.ts ADAPTERS): the Agent Client Protocol's (Kimi
 * Code, Grok) and Codex's app-server. Claude Code's is not ported yet: the
 * host refuses a chat of that kind as one of a kind without a chat
 * (unsupported, "this host has no adapter claude"), and lists it as
 * unsupported. */
export function chatAdapters(): Adapters {
  return { [Adapter.ACP]: acpAdapter(), [Adapter.Codex]: codexAdapter() };
}

// The machine sides of the features this build serves. The features whose
// machine side is not here yet (agents, chat, gui, vscode) are refused as
// an unknown plugin is (machine/agent.ts). Usage's session action finds a
// session's transcripts with the agents feature's locator, which this
// build does not have yet: every session is not_found meanwhile.
import type { MachineSide } from '#machine/feature.ts';
import { browserMachine } from '#features/browser/machine.ts';
import { filesMachine } from '#features/files/machine.ts';
import { gitMachine } from '#features/git/machine.ts';
import { historyMachine } from '#features/history/machine.ts';
import { monitorMachine } from '#features/monitor/machine.ts';
import { searchMachine } from '#features/search/machine.ts';
import { usageMachine } from '#features/usage/machine.ts';

export function machineFeatures(): MachineSide[] {
  return [
    filesMachine(),
    gitMachine(),
    searchMachine(),
    browserMachine(),
    monitorMachine(),
    historyMachine(),
    usageMachine(),
  ] as MachineSide[];
}

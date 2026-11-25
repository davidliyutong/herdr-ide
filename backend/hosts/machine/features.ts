// The machine sides of the features this build serves. The features whose
// machine side is not here yet (agents, usage, chat, gui, vscode) are
// refused as an unknown plugin is (machine/agent.ts).
import type { MachineSide } from '#machine/feature.ts';
import { browserMachine } from '#features/browser/machine.ts';
import { filesMachine } from '#features/files/machine.ts';
import { monitorMachine } from '#features/monitor/machine.ts';
import { searchMachine } from '#features/search/machine.ts';

export function machineFeatures(): MachineSide[] {
  return [filesMachine(), searchMachine(), browserMachine(), monitorMachine()] as MachineSide[];
}

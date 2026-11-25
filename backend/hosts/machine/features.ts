// The machine sides of the features this build serves. The features whose
// machine side is not here yet (agents, usage, chat, gui, vscode) are
// refused as an unknown plugin is (machine/agent.ts).
import type { MachineSide } from '#machine/feature.ts';

export function machineFeatures(): MachineSide[] {
  return [];
}

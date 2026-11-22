// The agents plugin: coding agents in terminals shown as their
// conversations (web/src/conversation), read from the sessions'
// transcripts on their machines (internal/plugins/agents). A terminal's
// pane whose leaf says render: native and whose agent has a native view
// shows the conversation over the terminal, which keeps running under it
// (Surface.tsx); the pane's header has the switch between the two
// (ViewToggle.tsx); the new-tab menu starts an agent shown so. Its
// commands are declared in internal/keybindings/commands.go.
import { Bot } from 'lucide-react';
import type { PluginDef } from '../api';
import { AgentSurface } from './Surface';
import { ViewToggle } from './ViewToggle';
import { agentTabKinds, agentTabPlace, agentTabTitle, covers, startAgentTab, SURFACE, toggleTarget, toggleView } from './view';

export const agentsPlugin: PluginDef = {
  id: 'agents',
  title: 'agents.title',
  description: 'agents.description',
  icon: Bot,
  commands: {
    'agents.toggleView': {
      enabled: () => !!toggleTarget(),
      run() {
        const target = toggleTarget();
        if (target) toggleView(target.m, target.terminal);
      },
    },
    'agents.newTab': {
      enabled: () => !!agentTabPlace() && agentTabKinds().length > 0,
      run() {
        const place = agentTabPlace();
        const kind = agentTabKinds()[0];
        if (place && kind) void startAgentTab(place.m, place.workspace, kind);
      },
    },
  },
  newTabItems: () =>
    agentTabKinds().map((kind) => ({
      id: `agents.${kind}`,
      title: agentTabTitle(kind),
      icon: Bot,
      run: (m, workspace) => startAgentTab(m, workspace, kind),
    })),
  terminalSurfaces: [{ id: SURFACE, covers, component: AgentSurface }],
  headerActions: [ViewToggle],
};

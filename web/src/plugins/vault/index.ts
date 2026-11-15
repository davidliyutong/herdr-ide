// The variable vault (docs/features/30-variable-vault.md): environment
// variables kept encrypted on the core host, which coding agents on the
// machines read through an MCP server. Its panel in the right sidebar, and
// the approval prompts on every page.
import { KeyRound } from 'lucide-react';
import type { PluginDef } from '../api';
import { VaultPanel } from './VaultPanel';
import { VaultApprovals } from './Approvals';
import { vaultMessage } from './api';

export const vaultPlugin: PluginDef = {
  id: 'vault',
  title: 'plugins.vault.title',
  description: 'plugins.vault.description',
  icon: KeyRound,
  panels: [{ id: 'vault', title: 'plugins.vault.title', icon: KeyRound, component: VaultPanel, command: 'view.panel.vault' }],
  statusItems: [VaultApprovals],
  onMessage: vaultMessage,
};

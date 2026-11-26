// The variable vault (docs/features/30-variable-vault.md): environment
// variables kept encrypted on the hub host, which coding agents on the
// machines read through an MCP server. Its panel in the right sidebar, and
// the approval prompts and the file dialogs (export, import) on every page:
// openVaultExport() and openVaultImport() open them from anywhere.
import { KeyRound } from 'lucide-react';
import type { PluginDef } from '../api';
import { VaultPanel } from './VaultPanel';
import { VaultApprovals } from './Approvals';
import { VaultDialogs } from './Transfer';
import { VaultSettingsExtra } from './SettingsExtra';
import { vaultMessage } from './api';

export { openVaultExport, openVaultImport } from './dialogs';

export const vaultPlugin: PluginDef = {
  id: 'vault',
  title: 'plugins.vault.title',
  description: 'plugins.vault.description',
  icon: KeyRound,
  panels: [{ id: 'vault', title: 'plugins.vault.title', icon: KeyRound, component: VaultPanel, command: 'view.panel.vault' }],
  statusItems: [VaultApprovals, VaultDialogs],
  settings: { section: 'vault', extra: VaultSettingsExtra },
  onMessage: vaultMessage,
};

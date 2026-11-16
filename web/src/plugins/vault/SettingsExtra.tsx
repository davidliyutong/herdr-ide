// The end of the vault's page in Settings: moving variables between vaults
// in encrypted files, with the panel's dialogs (Transfer.tsx). They ask for
// the vault's passphrase themselves, which unlocks a locked vault.
import { useEffect } from 'react';
import { Download, FileUp } from 'lucide-react';
import { t } from '../../i18n';
import type { PluginSettingsProps } from '../api';
import { loadErrorText, loadVault, useVault } from './api';
import { openVaultExport, openVaultImport } from './dialogs';

export function VaultSettingsExtra({ readOnly }: PluginSettingsProps) {
  const status = useVault((s) => s.status);
  const error = useVault((s) => s.error);
  const count = useVault((s) => s.variables.length);
  useEffect(() => void loadVault(), []);
  // A new vault has no passphrase yet: nothing to export, nothing to seal
  // an import with.
  const usable = !!status && !status.setup && !readOnly;
  const note = readOnly
    ? t('vault.readOnly')
    : error
      ? loadErrorText(error)
      : status?.setup
        ? t('vault.settings.setup')
        : status?.locked
          ? t('vault.settings.locked')
          : '';
  return (
    <div className="setting" data-vault-files>
      <h4 className="settings-group">{t('vault.settings.files')}</h4>
      <div className="setting-desc">{t('vault.settings.filesAbout')}</div>
      <div className="setting-control row-gap">
        <button data-action="import" disabled={!usable} onClick={() => openVaultImport()}>
          <FileUp /> {t('vault.import.open')}
        </button>
        <button data-action="export" disabled={!usable || count === 0} onClick={() => openVaultExport()}>
          <Download /> {t('vault.export.open')}
        </button>
      </div>
      {note && (
        <p className="settings-note" data-note>
          {note}
        </p>
      )}
    </div>
  );
}

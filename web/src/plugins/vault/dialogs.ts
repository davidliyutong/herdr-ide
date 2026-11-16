// Which of the vault's file dialogs is open (Transfer.tsx): exporting
// variables into an encrypted file, importing one. They are drawn over
// every page by the plugin's status item, so the panel and other places (a
// settings page) open the same dialogs.
import { create } from 'zustand';
import { APP_SLUG } from '../../brand';

export type VaultDialog = { kind: 'export'; names?: string[] } | { kind: 'import' };

export const useVaultDialog = create<{ dialog?: VaultDialog }>(() => ({}));

/** Opens the export dialog for the variables named, or for all. */
export function openVaultExport(names?: string[]) {
  useVaultDialog.setState({ dialog: { kind: 'export', names: names?.length ? [...names] : undefined } });
}

/** Opens the import dialog. */
export function openVaultImport() {
  useVaultDialog.setState({ dialog: { kind: 'import' } });
}

export function closeVaultDialog() {
  useVaultDialog.setState({ dialog: undefined });
}

/** The name an export file is saved under. */
export function exportFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${APP_SLUG}-vault-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

/** Hands the browser a file to save (the export file: ciphertext only). */
export function saveFile(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The largest export file the core reads (MaxExportFile). */
export const MAX_FILE = 16 << 20;

/** The least length of an export's passphrase (MinExportPassphrase). */
export const MIN_FILE_PASSPHRASE = 12;

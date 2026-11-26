import { test, expect } from '../harness/fixtures';
import { showPanel } from '../harness/ui';

const PASSPHRASE = 'correct horse battery';

interface VaultState {
  status: { locked: boolean; setup: boolean };
  variables: { name: string; value?: unknown }[];
}

test('the vault is created, keeps a variable without showing its value, locks and unlocks', async ({ app, instance }) => {
  const panel = await showPanel(app, 'Variable Vault');
  await panel.getByRole('textbox', { name: 'New passphrase' }).fill(PASSPHRASE);
  await panel.getByRole('textbox', { name: 'Repeat the passphrase' }).fill(PASSPHRASE);
  await panel.getByRole('button', { name: 'Create Vault' }).click();
  await expect(panel).toContainText('Unlocked on this page');

  await panel.getByRole('button', { name: 'Add Variable' }).click();
  const dialog = app.getByRole('dialog', { name: 'New Variable' });
  await dialog.getByLabel('Name').fill('E2E_TOKEN');
  await dialog.getByLabel('Value', { exact: true }).fill('s3cret-value');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel).toContainText('E2E_TOKEN');

  // The API lists it, never its value.
  const state = await instance.api<VaultState>('GET', '/api/p/vault');
  expect(state.variables.map((v) => v.name)).toEqual(['E2E_TOKEN']);
  expect(JSON.stringify(state)).not.toContain('s3cret-value');

  // Locked, no value leaves it; the passphrase opens it again.
  await panel.getByRole('button', { name: 'Lock' }).click();
  await expect(panel.getByRole('textbox', { name: 'Passphrase' })).toBeVisible();
  expect((await instance.api<VaultState>('GET', '/api/p/vault')).status.locked).toBe(true);
  const reveal = await instance.fetch('POST', '/api/p/vault/vars/E2E_TOKEN/reveal', {});
  expect(reveal.ok).toBe(false);
  await panel.getByRole('textbox', { name: 'Passphrase' }).fill(PASSPHRASE);
  await panel.getByRole('button', { name: 'Unlock' }).click();
  await expect(panel).toContainText('Unlocked on this page');
  await expect(panel).toContainText('E2E_TOKEN');
});

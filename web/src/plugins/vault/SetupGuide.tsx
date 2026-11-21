// The vault panel's setup guide: how to connect a coding agent's CLI on
// each machine.
import { useState } from 'react';
import { useStore } from '../../state/store';
import { t } from '../../i18n';
import { Picker } from '../../components/Picker';
import { setupSnippets } from './setup';
import { CopyButton, machineItems } from './shared';

/** Per machine: how to add the vault's MCP server to a coding agent's CLI. */
export function SetupGuide() {
  const machines = useStore((s) => s.machines);
  const order = useStore((s) => s.order);
  const [m, setM] = useState('');
  const id = m && machines[m] ? m : order[0];
  const info = id ? machines[id]?.info : undefined;
  const s = setupSnippets(info);
  const block = (title: string, text: string, kind: string) => (
    <div className="vault-snippet" data-snippet={kind}>
      <div className="vault-snippet-head">
        <span>{title}</span>
        <span className="spacer" />
        <CopyButton text={text} label={t('vault.copy')} />
      </div>
      <pre>{text}</pre>
    </div>
  );
  return (
    <div className="vault-setup">
      {order.length > 1 && (
        <Picker
          aria-label={t('vault.setup.machine')}
          label={t('vault.setup.machine')}
          keepOrder
          items={machineItems(order, machines)}
          value={id}
          onChange={setM}
        />
      )}
      {block(t('vault.setup.claude'), s.claude, 'claude')}
      {block(t('vault.setup.codex'), s.codex, 'codex')}
      {block(t('vault.setup.json'), s.json, 'json')}
      <p className="vault-hint">{t('vault.setup.note')}</p>
      {id && machines[id]?.kind === 'local' && (
        <p className="vault-hint" data-note="local">
          {t('vault.localNote')}
        </p>
      )}
    </div>
  );
}

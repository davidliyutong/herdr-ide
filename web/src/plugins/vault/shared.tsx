// What the vault panel's tabs share.
import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { t } from '../../i18n';
import type { PickerItem } from '../../components/Picker';
import type { MachineState } from '../../lib/machine';

/** Copies a text to the clipboard. */
export function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

/** A button that copies text, showing a check for a moment once it did. */
export function CopyButton({ text, label, action }: { text: string; label: string; action?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = window.setTimeout(() => setDone(false), 1200);
    return () => window.clearTimeout(id);
  }, [done]);
  return (
    <button
      type="button"
      className="icon sm vault-copy"
      data-action={action}
      title={label}
      aria-label={label}
      onClick={() => {
        copy(text);
        setDone(true);
      }}
    >
      {done ? <Check /> : <Copy />}
    </button>
  );
}

/** The machines to choose from: the core's, with their state, and any
 * chosen one it no longer has (by its id). */
export function machineItems(
  order: string[],
  machines: Record<string, MachineState | undefined>,
  picked: readonly string[] = [],
): PickerItem[] {
  const items: PickerItem[] = order.map((m) => ({
    value: m,
    label: machines[m]?.label ?? m,
    icon: <span className={`mstatus ms-${machines[m]?.status ?? 'idle'}`} />,
    description: machines[m]?.kind === 'local' ? t('vault.thisComputer') : undefined,
    keywords: m,
  }));
  for (const m of picked) if (!order.includes(m)) items.push({ value: m, label: m });
  return items;
}

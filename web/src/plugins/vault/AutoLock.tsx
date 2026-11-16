// The auto-lock's countdown in the vault panel's session bar: when the
// vault locks if nothing uses it; a click picks another time for this
// unlock (presets, never, or a time typed), which holds until the vault
// locks (docs/features/30-variable-vault.md).
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Timer, TimerOff } from 'lucide-react';
import { pick, type PickerItem } from '../../components/Picker';
import { t } from '../../i18n';
import { useStore } from '../../state/store';
import { errorText, loadVault, setAutoLock, useVault } from './api';
import { clockText, minutesText, parseMinutes, PRESETS } from './lockTimes';

export function AutoLockButton() {
  const al = useVault((s) => s.autoLock);
  const lockAt = al?.lockAt ? Date.parse(al.lockAt) : undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (lockAt === undefined) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [lockAt]);
  const left = lockAt === undefined ? undefined : (lockAt - now) / 1000;
  // At zero the vault locked, or a use elsewhere moved the time: ask the
  // core again, at most every 5 s.
  const asked = useRef(0);
  const due = left !== undefined && left <= 0;
  useEffect(() => {
    if (due && Date.now() - asked.current > 5000) {
      asked.current = Date.now();
      void loadVault();
    }
  }, [due, now]);
  if (!al) return null;

  const off = al.after === 0;
  const text = off ? t('vault.autoLock.off') : left !== undefined ? clockText(left) : minutesText(Math.round(al.after / 60));
  const choose = async (e: MouseEvent<HTMLButtonElement>) => {
    const items: PickerItem[] = [
      {
        value: 'default',
        label: t('vault.autoLock.default', { time: al.setting ? minutesText(Math.round(al.setting / 60)) : t('vault.autoLock.never') }),
      },
      ...PRESETS.map((n) => ({ value: String(n), label: minutesText(n) })),
      { value: 'never', label: t('vault.autoLock.never') },
    ];
    const value = !al.custom ? 'default' : off ? 'never' : String(Math.round(al.after / 60));
    const r = await pick(e.currentTarget, {
      items,
      value,
      keepOrder: true,
      label: t('vault.autoLock.label'),
      placeholder: t('vault.autoLock.placeholder'),
      create: (q) => {
        const n = parseMinutes(q);
        return n === undefined ? undefined : t('vault.autoLock.custom', { time: minutesText(n) });
      },
    });
    if (r === undefined) return;
    const minutes = typeof r === 'object' ? (parseMinutes(r.create) ?? null) : r === 'default' ? null : r === 'never' ? 0 : Number(r);
    if (typeof r === 'object' && minutes === null) return;
    try {
      await setAutoLock(minutes);
    } catch (err) {
      useStore.getState().toast(errorText(err), undefined, undefined, 'error');
    }
  };
  return (
    <button
      className={'sm ghost vault-autolock' + (al.custom ? ' custom' : '')}
      title={off ? t('vault.autoLock.offTitle') : t('vault.autoLock.title', { time: minutesText(Math.round(al.after / 60)) })}
      aria-label={left !== undefined ? t('vault.autoLock.left', { time: clockText(left) }) : text}
      onClick={(e) => void choose(e)}
    >
      {off ? <TimerOff /> : <Timer />}
      <span className="vault-autolock-time">{text}</span>
    </button>
  );
}

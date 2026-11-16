import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { actions, attentionList, terminalPlace, workspaceTitle } from '../actions';
import { commandEnabled, commandLabel, keyHint, runCommand } from '../keymap';
import { useKeys } from '../keybindings';
import { locales, t, type MessageKey } from '../i18n';
import { usePrefs } from '../prefs';
import { agentOf, terminalTitle } from '../lib/machine';
import { useTerms } from '../state/terms';
import { StatusDot } from './StatusDot';
import { pluginPaletteItems } from '../plugins/registry';
import { match, matchScore } from '../lib/match';
import { Highlight } from './Highlight';
import { titleIfCut } from './ContextMenu';
import { useReturnFocus } from './useDismiss';

/** Items drawn at most; typing narrows the rest. */
const SHOWN = 200;
/** Items a page key moves. */
const PAGE = 8;

// The matcher is shared with the pickers (lib/match.ts).
export { matchScore };

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  run(): void;
}

export function Palette() {
  const mode = useStore((s) => s.palette);
  const setPalette = useStore((s) => s.setPalette);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The keyboard's item is scrolled into view; the pointer's is not.
  const reveal = useRef(false);
  useReturnFocus(!!mode);
  useLayoutEffect(() => {
    if (!reveal.current) return;
    reveal.current = false;
    listRef.current?.querySelector('.palette-item.sel')?.scrollIntoView?.({ block: 'nearest' });
  }, [sel]);

  useEffect(() => {
    setQ('');
    setSel(0);
    if (mode) setTimeout(() => inputRef.current?.focus(), 0);
  }, [mode]);

  const items = useMemo<Item[]>(() => {
    if (!mode) return [];
    const s = useStore.getState();
    const ws: Item[] = [];
    const tm = useTerms.getState().machines;
    for (const m of s.order) {
      const st = s.machines[m];
      for (const w of tm[m]?.layout?.workspaces ?? []) {
        ws.push({
          id: `ws:${m}:${w.id}`,
          label: workspaceTitle(m, w),
          hint: st?.label,
          run: () => actions.selectWorkspace(m, w.id),
        });
      }
    }
    // An agent by its name and where it is (its workspace and tab).
    const agents: Item[] = attentionList().map(({ m, terminal, record, status }) => ({
      id: `agent:${m}:${terminal}`,
      label: `${agentOf(record) ?? terminalTitle(record, terminal)} · ${terminalPlace(m, terminal) || terminalTitle(record, terminal)}`,
      hint: s.machines[m]?.label,
      icon: <StatusDot status={status} />,
      run: () => actions.focusPane(m, terminal),
    }));
    // Commands that open the palette, the tabs by number and commands that
    // cannot run now are left out.
    const hidden = /^(app\.commandPalette|workspace\.switch|tab\.select\d)$/;
    const cmds: Item[] = useKeys
      .getState()
      .commands.filter((c) => !hidden.test(c.id) && commandEnabled(c.id))
      .map((c) => ({ id: `cmd:${c.id}`, label: commandLabel(c.id), hint: keyHint(c.id) || undefined, run: () => runCommand(c.id) }));
    const kinds = ['claude', 'codex', 'gemini', 'opencode', 'kimi', 'grok', 'cursor', 'copilot', 'qwen', 'amp'];
    for (const k of kinds) {
      cmds.push({ id: `start:${k}`, label: t('action.startAgent', { kind: k }), run: () => void actions.startAgent(k) });
    }
    for (const l of locales) {
      cmds.push({
        id: `locale:${l.id}`,
        label: t('action.language', { lang: l.label }),
        run: () => usePrefs.getState().setPref('locale', l.id),
      });
    }
    for (const th of ['system', 'dark', 'light'] as const) {
      cmds.push({
        id: `theme:${th}`,
        label: t('action.theme', { theme: t(`settings.appearance.theme.${th}` as MessageKey) }),
        run: () => usePrefs.getState().setPref('theme', th),
      });
    }
    cmds.push(...pluginPaletteItems());
    if (mode === 'workspaces') return [...ws, ...agents];
    return [...cmds, ...ws, ...agents];
  }, [mode]);

  const filtered = q
    ? items
        .map((i) => ({ i, score: matchScore(q, i.label + ' · ' + (i.hint ?? '')) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.i)
    : items;
  if (!mode) return null;

  const close = () => setPalette(undefined);
  const shown = filtered.slice(0, SHOWN);
  const move = (to: number) => {
    reveal.current = true;
    setSel(Math.max(0, Math.min(to, shown.length - 1)));
  };
  const run = (i?: Item) => {
    close();
    i?.run();
  };

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          placeholder={t(mode === 'workspaces' ? 'palette.placeholderWorkspaces' : 'palette.placeholder')}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            else if (e.key === 'ArrowDown') move(sel + 1);
            else if (e.key === 'ArrowUp') move(sel - 1);
            else if (e.key === 'PageDown') move(sel + PAGE);
            else if (e.key === 'PageUp') move(sel - PAGE);
            else if (e.key === 'Enter') run(filtered[sel]);
            else return;
            e.preventDefault();
          }}
        />
        <div className="palette-list" ref={listRef} role="listbox" aria-label={t('palette.placeholder')}>
          {shown.map((i, idx) => (
            <div
              key={i.id}
              role="option"
              aria-selected={idx === sel}
              className={`palette-item ${idx === sel ? 'sel' : ''}`}
              onMouseEnter={(e) => {
                titleIfCut(e);
                setSel(idx);
              }}
              onClick={() => run(i)}
            >
              {i.icon}
              <span className="ellipsis">
                <Highlight text={i.label} ranges={q ? match(q, i.label)?.ranges : undefined} />
              </span>
              {i.hint && <span className="muted small hint">{i.hint}</span>}
            </div>
          ))}
          {filtered.length > SHOWN && <div className="muted small pad">{t('palette.more', { n: filtered.length - SHOWN })}</div>}
          {filtered.length === 0 && <div className="muted pad">{t('palette.noMatch')}</div>}
        </div>
      </div>
    </div>
  );
}

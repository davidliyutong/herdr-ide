import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { actions, attentionList, attentionName, attentionTitle, current, focusAttention, terminalPlace, workspaceTitle } from '../actions';
import { commandEnabled, commandLabel, keyHint, runCommand } from '../keymap';
import { useKeys } from '../keybindings';
import { locales, t, type MessageKey } from '../i18n';
import { usePrefs } from '../prefs';
import { useTerms } from '../state/terms';
import { StatusDot } from './StatusDot';
import { pluginPaletteItems } from '../plugins/registry';
import { match, matchScore } from '../lib/match';
import { Highlight } from './Highlight';
import { titleIfCut } from './ContextMenu';
import { useReturnFocus } from './useDismiss';
import { revealTop, visibleRange } from '../lib/windowed';
import { useSize } from '../lib/sizes';
import { AGENT_KINDS, startArgv } from '../conversation/kinds';

// The matcher is shared with the pickers (lib/match.ts).
export { matchScore };

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  run(): void;
}

/** The palette's commands that start an agent: each kind the registry
 * starts (conversation/kinds.ts), in its order, with the argv it gives. */
export function agentStartItems(): Array<{ id: string; label: string; argv: string[] }> {
  return AGENT_KINDS.flatMap((k) => {
    const argv = startArgv(k.id);
    return argv ? [{ id: `start:${k.id}`, label: t('action.startAgent', { kind: k.id }), argv }] : [];
  });
}

/** Runs argv in a new terminal split to the right of the focused pane, or
 * in a new tab when no pane is focused. */
async function startBeside(argv: string[]) {
  const c = current();
  if (!c) return;
  if (c.focused) await actions.split(c.m, c.focused, 'right', argv);
  else await actions.newTab(c.m, undefined, argv);
}

export function Palette() {
  const mode = useStore((s) => s.palette);
  const setPalette = useStore((s) => s.setPalette);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Only the items in view are drawn (lib/windowed.ts), so every item is
  // listed however many there are: rows of one height, in a view of at most
  // half the window.
  const rowPx = useSize('toolbar');
  const [scrollTop, setScrollTop] = useState(0);
  // The keyboard's item is scrolled into view; the pointer's is not.
  const reveal = useRef(false);
  useReturnFocus(!!mode);

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
    const agents: Item[] = attentionList().map((i) => ({
      id: `agent:${i.m}:${i.terminal}`,
      label: i.unopened ? attentionName(i) : `${attentionName(i)} · ${terminalPlace(i.m, i.terminal) || attentionTitle(i)}`,
      hint: s.machines[i.m]?.label,
      icon: <StatusDot status={i.status} />,
      run: () => focusAttention(i),
    }));
    // Commands that open the palette, the tabs by number and commands that
    // cannot run now are left out.
    const hidden = /^(app\.commandPalette|workspace\.switch|tab\.select\d)$/;
    const cmds: Item[] = useKeys
      .getState()
      .commands.filter((c) => !hidden.test(c.id) && commandEnabled(c.id))
      .map((c) => ({ id: `cmd:${c.id}`, label: commandLabel(c.id), hint: keyHint(c.id) || undefined, run: () => runCommand(c.id) }));
    for (const a of agentStartItems()) cmds.push({ id: a.id, label: a.label, run: () => void startBeside(a.argv) });
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
  const total = filtered.length * rowPx;
  const viewHeight = Math.min(total, Math.round(window.innerHeight * 0.5));
  const page = Math.max(1, Math.floor(viewHeight / rowPx) - 1);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!reveal.current || !el) return;
    reveal.current = false;
    const top = revealTop(el.scrollTop, viewHeight, sel * rowPx, (sel + 1) * rowPx);
    if (top !== el.scrollTop) {
      el.scrollTop = top;
      setScrollTop(top);
    }
  }, [sel, viewHeight, rowPx]);
  // A new query starts at the top.
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [q, mode]);
  if (!mode) return null;

  const close = () => setPalette(undefined);
  const move = (to: number) => {
    reveal.current = true;
    setSel(Math.max(0, Math.min(to, filtered.length - 1)));
  };
  const [from, to] = visibleRange(filtered.length, rowPx, scrollTop, viewHeight);
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
            else if (e.key === 'PageDown') move(sel + page);
            else if (e.key === 'PageUp') move(sel - page);
            else if (e.key === 'Enter') run(filtered[sel]);
            else return;
            e.preventDefault();
          }}
        />
        <div
          className="palette-list"
          ref={listRef}
          role="listbox"
          aria-label={t('palette.placeholder')}
          style={filtered.length ? { height: viewHeight } : undefined}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          {filtered.length > 0 && (
            <div className="palette-rows" style={{ height: total }}>
              {filtered.slice(from, to).map((i, k) => {
                const idx = from + k;
                return (
                  <div
                    key={i.id}
                    role="option"
                    aria-selected={idx === sel}
                    aria-setsize={filtered.length}
                    aria-posinset={idx + 1}
                    className={`palette-item ${idx === sel ? 'sel' : ''}`}
                    style={{ top: idx * rowPx, height: rowPx }}
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
                );
              })}
            </div>
          )}
          {filtered.length === 0 && <div className="muted pad">{t('palette.noMatch')}</div>}
        </div>
      </div>
    </div>
  );
}

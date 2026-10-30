import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { actions, attentionList } from '../actions';
import { actionLabel, defaultBindings, getKeyConfig, keyLabel, runAction, runCommand } from '../keymap';
import { locales, t, type MessageKey } from '../i18n';
import { prefDefs, usePrefs } from '../prefs';
import { paneTitle } from '../lib/herdr';
import { StatusDot } from './StatusDot';
import { useGui } from '../gui/state';
import { enableGui } from '../gui/enable';

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  run(): void;
}

function fuzzy(q: string, s: string): boolean {
  q = q.toLowerCase();
  s = s.toLowerCase();
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length;
}

export function Palette() {
  const mode = useStore((s) => s.palette);
  const setPalette = useStore((s) => s.setPalette);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQ('');
    setSel(0);
    if (mode) setTimeout(() => inputRef.current?.focus(), 0);
  }, [mode]);

  const items = useMemo<Item[]>(() => {
    if (!mode) return [];
    const s = useStore.getState();
    const cfg = getKeyConfig();
    const ws: Item[] = [];
    for (const m of s.order) {
      const st = s.machines[m];
      for (const w of st?.snapshot?.workspaces ?? []) {
        ws.push({
          id: `ws:${m}:${w.workspace_id}`,
          label: `${w.label}`,
          hint: st.label,
          run: () => s.selectWorkspace(m, w.workspace_id),
        });
      }
    }
    const agents: Item[] = attentionList().map(({ m, pane }) => ({
      id: `agent:${m}:${pane.pane_id}`,
      label: `${pane.agent} · ${paneTitle(pane)}`,
      hint: s.machines[m]?.label,
      icon: <StatusDot status={pane.agent_status} />,
      run: () => actions.focusAgent(m, pane.pane_id),
    }));
    const cmds: Item[] = Object.entries(cfg.bindings)
      .filter(([a]) => a in defaultBindings && !['help', 'command_palette', 'goto', 'workspace_picker', 'switch_tab'].includes(a))
      .map(([a, spec]) => ({
        id: `cmd:${a}`,
        label: actionLabel(a),
        hint: keyLabel(spec, cfg.prefix),
        run: () => runAction(a),
      }));
    for (const c of cfg.commands) {
      cmds.push({
        id: `custom:${c.key}`,
        label: c.description || c.command,
        hint: keyLabel(c.key, cfg.prefix),
        run: () => runCommand(c),
      });
    }
    const kinds = ['claude', 'codex', 'gemini', 'opencode', 'kimi', 'grok', 'cursor', 'copilot', 'qwen', 'amp'];
    for (const k of kinds) {
      cmds.push({ id: `start:${k}`, label: t('action.startAgent', { kind: k }), run: () => actions.startAgent(k) });
    }
    for (const l of locales) {
      cmds.push({
        id: `locale:${l.id}`,
        label: t('action.language', { lang: l.label }),
        run: () => usePrefs.getState().setPref('locale', l.id),
      });
    }
    for (const th of prefDefs.theme.options) {
      cmds.push({
        id: `theme:${th}`,
        label: t('action.theme', { theme: t(`settings.theme.${th}` as MessageKey) }),
        run: () => usePrefs.getState().setPref('theme', th),
      });
    }
    const f = s.focused;
    if (f && useGui.getState().machines[f.m]?.phase === 'ready') {
      cmds.push({ id: 'gui:pane', label: t('action.enableGuiPane'), run: () => void enableGui(f.m, [f.pane]) });
    }
    for (const st of Object.values(useGui.getState().machines)) {
      if (st.phase !== 'ready') continue;
      cmds.push({
        id: `gui:${st.m}`,
        label: t('action.enableGuiMachine', { m: s.machines[st.m]?.label ?? st.m }),
        run: () => void enableGui(st.m),
      });
    }
    if (mode === 'workspaces') return [...ws, ...agents];
    if (mode === 'help') return cmds;
    return [...cmds, ...ws, ...agents];
  }, [mode]);

  const filtered = q ? items.filter((i) => fuzzy(q, i.label + ' ' + (i.hint ?? ''))) : items;
  if (!mode) return null;

  const close = () => setPalette(undefined);
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
          placeholder={t(
            mode === 'workspaces' ? 'palette.placeholderWorkspaces' : mode === 'help' ? 'palette.placeholderHelp' : 'palette.placeholder',
          )}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            else if (e.key === 'ArrowDown') setSel((v) => Math.min(v + 1, filtered.length - 1));
            else if (e.key === 'ArrowUp') setSel((v) => Math.max(v - 1, 0));
            else if (e.key === 'Enter') run(filtered[sel]);
            else return;
            e.preventDefault();
          }}
        />
        <div className="palette-list">
          {filtered.slice(0, 200).map((i, idx) => (
            <div key={i.id} className={`palette-item ${idx === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(idx)} onClick={() => run(i)}>
              {i.icon}
              <span className="ellipsis">{i.label}</span>
              {i.hint && <span className="muted small hint">{i.hint}</span>}
            </div>
          ))}
          {filtered.length === 0 && <div className="muted pad">{t('palette.noMatch')}</div>}
        </div>
      </div>
    </div>
  );
}

// The Agent Chats plugin's page in Settings (PluginSettingsDef.layout), modeled
// after AI Usage's SettingsPage (plugins/usage/SettingsPage.tsx): the general
// chat settings, then a Providers list where each AI coding agent opens a
// secondary sub-page with Model List Refresh and per-model visibility
// checkboxes (persisted to chat.visibleModels.<kind>). The plugin's extra
// section (Headless Chat Hosts & Trusted Folders) stays on the first page only.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { CATEGORY_MODEL } from '../../conversation/model';
import { chatKinds, usageProvider } from '../../conversation/kinds';
import { locale, t } from '../../i18n';
import { resetSetting, setSetting, useSettings, type SettingDef } from '../../settings';
import { useStore } from '../../state/store';
import type { PluginSettingsLayoutProps } from '../api';
import { ProviderLogo } from '../usage/logos';
import { CHAT_PROVIDERS, ChatFailure, chatApi, failureText, visibleModelsFor } from './api';
import { agentName } from './ops';
import type { ModelOption } from './protocol';
import { useChats } from './state';

const VISIBLE_PREFIX = 'chat.visibleModels.';

/** The chat providers shown on the settings page, in canonical order. */
export function chatProviderIds(defs: readonly SettingDef[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (id: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of CHAT_PROVIDERS) add(id);
  for (const k of chatKinds()) add(k.id);
  for (const d of defs) if (d.key.startsWith(VISIBLE_PREFIX)) add(d.key.slice(VISIBLE_PREFIX.length));
  return out;
}

function providerOfRow(row?: string): string | undefined {
  return row?.startsWith(VISIBLE_PREFIX) ? row.slice(VISIBLE_PREFIX.length) : undefined;
}

function formatTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

export function ChatSettingsPage({ defs, rows, lead, footer, machine, readOnly, visit }: PluginSettingsLayoutProps) {
  const values = useSettings((s) => s.values);
  const asked = useStore((s) => s.settings?.row);
  const providers = useMemo(() => chatProviderIds(defs), [defs]);
  const [open, setOpen] = useState<string | undefined>(() => {
    const p = providerOfRow(asked);
    return p && providers.includes(p) ? p : undefined;
  });

  // Opened directly at a provider's setting row (e.g. from the composer's "Manage models…").
  useEffect(() => {
    const p = providerOfRow(asked);
    if (p && providers.includes(p)) setOpen(p);
  }, [asked, providers]);

  // Clicking Agent Chats in the settings sidebar again returns to the root page.
  const seenVisit = useRef(visit);
  useEffect(() => {
    if (seenVisit.current !== visit) setOpen(undefined);
    seenVisit.current = visit;
  }, [visit]);

  // Machine scope shows only machine-scoped rows (visible models are app-scoped).
  const generalDefs = useMemo(() => defs.filter((d) => !d.key.startsWith(VISIBLE_PREFIX)), [defs]);

  if (!machine && open && providers.includes(open)) {
    return <ProviderModelsPage kind={open} readOnly={readOnly} onBack={() => setOpen(undefined)} />;
  }

  return (
    <>
      {lead}
      {rows(generalDefs)}
      {!machine && providers.length > 0 && (
        <>
          <h4 className="settings-group">{t('settings.group.chatModels')}</h4>
          <div className="chat-settings-providers">
            {providers.map((id) => {
              const key = `${VISIBLE_PREFIX}${id}`;
              const selected = visibleModelsFor(values, id);
              const modified = values[key]?.source === 'global' && selected.length > 0;
              const summary =
                selected.length > 0 ? t('chat.settings.modelsSelected', { n: selected.length }) : t('chat.settings.modelsAll');
              return (
                <button
                  key={id}
                  type="button"
                  className={['setting chat-settings-row', modified && 'modified'].filter(Boolean).join(' ')}
                  data-provider={id}
                  onClick={() => setOpen(id)}
                >
                  <ProviderLogo provider={usageProvider(id) ?? id} />
                  <span className="setting-title ellipsis">{agentName(id)}</span>
                  <span className="muted">{summary}</span>
                  <ChevronRight aria-hidden />
                </button>
              );
            })}
          </div>
        </>
      )}
      {footer}
    </>
  );
}

function ProviderModelsPage({ kind, readOnly, onBack }: { kind: string; readOnly: boolean; onBack(): void }) {
  const values = useSettings((s) => s.values);
  const machines = useStore((s) => s.machines);
  const order = useStore((s) => s.order);
  const activeMachine = useStore((s) => s.machineId);
  const liveChats = useChats((s) => s.live);
  const chatStates = useChats((s) => s.states);

  const readyMachines = useMemo(
    () => order.map((id) => machines[id]).filter((m): m is NonNullable<typeof m> => !!m && m.status === 'ready'),
    [order, machines],
  );
  const [targetMachine, setTargetMachine] = useState<string>(() => {
    if (activeMachine && machines[activeMachine]?.status === 'ready') return activeMachine;
    return readyMachines[0]?.id ?? '';
  });
  useEffect(() => {
    if (targetMachine && readyMachines.some((m) => m.id === targetMachine)) return;
    setTargetMachine((activeMachine && readyMachines.find((m) => m.id === activeMachine)?.id) ?? readyMachines[0]?.id ?? '');
  }, [targetMachine, readyMachines, activeMachine]);

  const [cached, setCached] = useState<ModelOption[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [hint, setHint] = useState<string | undefined>();
  const [filter, setFilter] = useState('');
  const reqRef = useRef(0);

  const settingKey = `${VISIBLE_PREFIX}${kind}`;
  const locked = !!values[settingKey]?.locked;
  const saved = useMemo(() => visibleModelsFor(values, kind), [values, kind]);
  const agent = agentName(kind);
  const provider = usageProvider(kind) ?? kind;

  // Read cached models on mount / machine switch without spawning host or agent.
  useEffect(() => {
    const seq = ++reqRef.current;
    setCached([]);
    setFetchedAt(undefined);
    setError(undefined);
    setHint(undefined);
    if (!targetMachine) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void chatApi
      .models(targetMachine, kind)
      .then((res) => {
        if (seq !== reqRef.current) return;
        setCached(res.models);
        setFetchedAt(res.fetchedAt);
      })
      .catch((e: unknown) => {
        if (seq !== reqRef.current) return;
        // not_running / not_found simply means no cache yet; keep empty state clean.
        if (e instanceof ChatFailure && (e.code === 'not_running' || e.code === 'not_found')) return;
        setError(failureText(e, agent, 'chat.settings.refreshFailed'));
      })
      .finally(() => {
        if (seq === reqRef.current) setLoading(false);
      });
  }, [targetMachine, kind, agent]);

  const handleRefresh = useCallback(async () => {
    if (readOnly || !targetMachine || refreshing) return;
    const seq = ++reqRef.current;
    setRefreshing(true);
    setError(undefined);
    setHint(undefined);
    try {
      const res = await chatApi.refreshModels(targetMachine, kind);
      if (seq !== reqRef.current) return;
      setCached(res.models);
      setFetchedAt(res.fetchedAt);
    } catch (e: unknown) {
      if (seq !== reqRef.current) return;
      setError(failureText(e, agent, 'chat.settings.refreshFailed'));
    } finally {
      if (seq === reqRef.current) setRefreshing(false);
    }
  }, [readOnly, targetMachine, refreshing, kind, agent]);

  // Combine cached/refreshed models with any models already observed in open live
  // chats of this agent kind, plus any saved allowlist entries not yet in cache.
  const allModels = useMemo(() => {
    const byId = new Map<string, ModelOption>();
    for (const m of cached) byId.set(m.value, m);
    for (const [k, live] of Object.entries(liveChats)) {
      const [mId, chatId] = k.split('\n');
      const chatKind = chatStates[mId]?.[chatId]?.kind;
      if (chatKind && chatKind !== kind) continue;
      if (!chatKind) continue;
      const opt = live.info?.config?.find((c) => c.category === CATEGORY_MODEL);
      for (const v of opt?.options ?? []) {
        if (!byId.has(v.value)) byId.set(v.value, { value: v.value, name: v.name || v.value, description: v.description });
      }
    }
    for (const id of saved) {
      if (!byId.has(id)) byId.set(id, { value: id, name: id });
    }
    return [...byId.values()];
  }, [cached, liveChats, chatStates, kind, saved]);

  const savedSet = useMemo(() => new Set(saved), [saved]);
  const allShown = saved.length === 0;
  const shownCount = allShown ? allModels.length : allModels.filter((m) => savedSet.has(m.value)).length;

  const filteredModels = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allModels;
    return allModels.filter(
      (m) =>
        m.name.toLowerCase().includes(q) || m.value.toLowerCase().includes(q) || (m.description && m.description.toLowerCase().includes(q)),
    );
  }, [allModels, filter]);

  const saveList = useCallback(
    async (next: string[]) => {
      setHint(undefined);
      setError(undefined);
      const err = next.length === 0 ? await resetSetting(settingKey) : await setSetting(settingKey, next);
      if (err) setError(err);
    },
    [settingKey],
  );

  const toggleModel = useCallback(
    (id: string) => {
      if (readOnly || locked) return;
      const allIds = allModels.map((m) => m.value);
      const cur = new Set(allShown ? allIds : saved);
      if (cur.has(id)) {
        if (cur.size <= 1) {
          setHint(t('chat.settings.keepOne'));
          return;
        }
        cur.delete(id);
      } else {
        cur.add(id);
      }
      // Checking every known model resets back to empty (= show all).
      if (allIds.length > 0 && allIds.every((x) => cur.has(x))) {
        void saveList([]);
        return;
      }
      const ordered = allIds.filter((x) => cur.has(x));
      for (const x of cur) if (!ordered.includes(x)) ordered.push(x);
      void saveList(ordered);
    },
    [readOnly, locked, allModels, allShown, saved, saveList],
  );

  const disabled = readOnly || locked;

  return (
    <div className="chat-settings-provider" data-provider={kind}>
      <button type="button" className="sm chat-settings-back" data-action="back" onClick={onBack}>
        <ArrowLeft aria-hidden /> {t('chat.settings.back')}
      </button>
      <h4 className="chat-settings-title">
        <ProviderLogo provider={provider} />
        <span>{agent}</span>
      </h4>
      <div className="setting chat-models-section">
        <div className="setting-head">
          <span className="setting-title">{t('chat.settings.modelsTitle')}</span>
          {readyMachines.length > 1 && (
            <select
              className="chat-settings-machine"
              aria-label={t('chat.manage.machine')}
              value={targetMachine}
              onChange={(e) => setTargetMachine(e.target.value)}
            >
              {readyMachines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label || m.id}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="sm chat-models-refresh"
            disabled={readOnly || !targetMachine || refreshing}
            onClick={() => void handleRefresh()}
          >
            <RefreshCw className={refreshing ? 'spin' : undefined} aria-hidden />
            {refreshing ? t('chat.settings.refreshing') : t('chat.settings.refresh')}
          </button>
          {!allShown && !disabled && (
            <button type="button" className="ghost sm chat-models-show-all" onClick={() => void saveList([])}>
              {t('chat.settings.showAll')}
            </button>
          )}
        </div>
        <div className="setting-desc">{t('chat.settings.modelsDesc', { agent })}</div>
        {(fetchedAt || allModels.length > 0) && (
          <div className="chat-models-meta muted small">
            {allModels.length > 0 && <span>{t('chat.settings.modelsCount', { shown: shownCount, total: allModels.length })}</span>}
            {fetchedAt && <span>{t('chat.settings.refreshedAt', { when: formatTime(fetchedAt) })}</span>}
          </div>
        )}
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        {hint && <p className="muted small">{hint}</p>}
        {allModels.length > 6 && (
          <input
            type="search"
            className="settings-input chat-models-filter"
            value={filter}
            placeholder={t('chat.settings.filterPlaceholder')}
            aria-label={t('chat.settings.filterPlaceholder')}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
        {loading && allModels.length === 0 ? (
          <p className="muted small">{t('chat.manage.loading')}</p>
        ) : !targetMachine && allModels.length === 0 ? (
          <p className="muted small">{t('chat.settings.noMachine')}</p>
        ) : allModels.length === 0 ? (
          <p className="muted small">{t(readOnly ? 'chat.settings.noModelsReadOnly' : 'chat.settings.noModels', { agent })}</p>
        ) : filteredModels.length === 0 ? (
          <p className="muted small">{t('chat.settings.noMatches', { query: filter.trim() })}</p>
        ) : (
          <div className="chat-models-list" role="group" aria-label={t('chat.settings.modelsTitle')}>
            {filteredModels.map((m) => {
              const checked = allShown || savedSet.has(m.value);
              return (
                <label key={m.value} className={['chat-model-row', !checked && 'unchecked'].filter(Boolean).join(' ')} data-model={m.value}>
                  <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggleModel(m.value)} />
                  <span className="chat-model-info">
                    <span className="chat-model-head">
                      <span className="chat-model-name ellipsis">{m.name}</span>
                      {m.name !== m.value && <code className="chat-model-id">{m.value}</code>}
                    </span>
                    {m.description && <span className="chat-model-desc muted small">{m.description}</span>}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

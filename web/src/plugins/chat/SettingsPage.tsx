// The Agent Chats plugin's page in Settings (PluginSettingsDef.layout), modeled
// after AI Usage's SettingsPage (plugins/usage/SettingsPage.tsx): the general
// chat settings, then a Providers list where each AI coding agent opens a
// secondary sub-page with Model List Refresh and per-model visibility
// checkboxes (persisted to chat.visibleModels.<kind>), and the model a new
// chat starts with (chat.model.<kind>). The plugin's extra
// section (Headless Chat Hosts & Trusted Folders) stays on the first page only.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { CATEGORY_MODEL } from '../../conversation/model';
import { chatKinds, usageProvider } from '../../conversation/kinds';
import { hasMessage, locale, t, type MessageKey } from '../../i18n';
import { resetSetting, setSetting, useSettings, type SettingDef } from '../../settings';
import { useStore } from '../../state/store';
import type { PluginSettingsLayoutProps } from '../api';
import { ProviderLogo } from '../usage/logos';
import {
  CHAT_PROVIDERS,
  ChatFailure,
  LAST_MODEL,
  chatApi,
  failureText,
  isChatProviderEnabled,
  lastModelFor,
  modelUnavailable,
  startModelOptions,
  startModelSetting,
  visibleModelsFor,
} from './api';
import { agentName } from './ops';
import type { ModelOption } from './protocol';
import { useChats } from './state';

const PROVIDER_PREFIX = 'chat.providers.';
const VISIBLE_PREFIX = 'chat.visibleModels.';
const MODE_PREFIX = 'chat.permissionMode.';
const MODEL_PREFIX = 'chat.model.';
const LAST_PREFIX = 'chat.lastModel.';
/** The per-provider keys shown on a provider's page, not among the general rows. */
const PROVIDER_PREFIXES = [VISIBLE_PREFIX, PROVIDER_PREFIX, MODEL_PREFIX, LAST_PREFIX];

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
  for (const d of defs) {
    if (d.key.startsWith(PROVIDER_PREFIX)) add(d.key.slice(PROVIDER_PREFIX.length));
    else if (d.key.startsWith(VISIBLE_PREFIX)) add(d.key.slice(VISIBLE_PREFIX.length));
    else if (d.key.startsWith(MODE_PREFIX)) add(d.key.slice(MODE_PREFIX.length));
  }
  return out;
}

function providerOfRow(row?: string): string | undefined {
  const prefix = row ? [...PROVIDER_PREFIXES, MODE_PREFIX].find((p) => row.startsWith(p)) : undefined;
  return prefix ? row!.slice(prefix.length) : undefined;
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

  // User scope groups per-provider permission modes inside each provider's sub-page;
  // machine scope shows all machine-scoped rows including per-agent overrides.
  const generalDefs = useMemo(
    () => defs.filter((d) => !PROVIDER_PREFIXES.some((p) => d.key.startsWith(p)) && (machine ? true : !d.key.startsWith(MODE_PREFIX))),
    [defs, machine],
  );

  if (!machine && open && providers.includes(open)) {
    const modeDef = defs.find((d) => d.key === `${MODE_PREFIX}${open}`);
    return <ProviderModelsPage kind={open} modeDef={modeDef} rows={rows} readOnly={readOnly} onBack={() => setOpen(undefined)} />;
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
              const switchKey = `${PROVIDER_PREFIX}${id}`;
              const visibleKey = `${VISIBLE_PREFIX}${id}`;
              const modeKey = `${MODE_PREFIX}${id}`;
              const modelKey = `${MODEL_PREFIX}${id}`;
              const on = isChatProviderEnabled(values, id);
              const switchLocked = !!values[switchKey]?.locked;
              const selected = visibleModelsFor(values, id);
              const rawMode = values[modeKey]?.value;
              const customMode = typeof rawMode === 'string' && rawMode !== 'inherit' ? rawMode : undefined;
              const modified =
                values[switchKey]?.source === 'global' ||
                (values[visibleKey]?.source === 'global' && selected.length > 0) ||
                (values[modeKey]?.source === 'global' && !!customMode) ||
                (values[modelKey]?.source === 'global' && startModelSetting(values, id) !== '');
              const modelSummary =
                selected.length > 0 ? t('chat.settings.modelsSelected', { n: selected.length }) : t('chat.settings.modelsAll');
              const modeSummaryKey = customMode ? `settings.${modeKey}.${customMode}` : '';
              const modeSummary = customMode && hasMessage(modeSummaryKey) ? t(modeSummaryKey as MessageKey) : customMode;
              const summary = !on ? t('settings.off') : [modeSummary, modelSummary].filter(Boolean).join(' · ');
              const name = agentName(id);
              return (
                <div
                  key={id}
                  className={['setting chat-settings-row', !on && 'off', modified && 'modified'].filter(Boolean).join(' ')}
                  data-provider={id}
                  onClick={() => setOpen(id)}
                >
                  <button
                    type="button"
                    className="chat-settings-open"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(id);
                    }}
                  >
                    <ProviderLogo provider={usageProvider(id) ?? id} />
                    <span className="setting-title ellipsis">{name}</span>
                    <span className="muted">{summary}</span>
                  </button>
                  <button
                    type="button"
                    role="switch"
                    className="switch"
                    aria-checked={on}
                    aria-label={t('chat.settings.providerToggle', { agent: name })}
                    disabled={readOnly || switchLocked}
                    onClick={(e) => {
                      e.stopPropagation();
                      void setSetting(switchKey, !on);
                    }}
                  />
                  <ChevronRight className="chat-settings-chevron" aria-hidden />
                </div>
              );
            })}
          </div>
        </>
      )}
      {footer}
    </>
  );
}

function ProviderModelsPage({
  kind,
  modeDef,
  rows,
  readOnly,
  onBack,
}: {
  kind: string;
  modeDef?: SettingDef;
  rows: PluginSettingsLayoutProps['rows'];
  readOnly: boolean;
  onBack(): void;
}) {
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
  /** Local draft state when the user clicks Deselect All (empty setting means
   * "show all", so we hold 0 selected locally until they pick at least one). */
  const [cleared, setCleared] = useState(false);
  const reqRef = useRef(0);
  const refreshAbortRef = useRef<AbortController | null>(null);

  const switchKey = `${PROVIDER_PREFIX}${kind}`;
  const providerOn = isChatProviderEnabled(values, kind);
  const switchLocked = !!values[switchKey]?.locked;
  const settingKey = `${VISIBLE_PREFIX}${kind}`;
  const locked = !!values[settingKey]?.locked;
  const saved = useMemo(() => visibleModelsFor(values, kind), [values, kind]);
  const agent = agentName(kind);
  const provider = usageProvider(kind) ?? kind;

  useEffect(() => {
    setCleared(false);
  }, [kind]);

  // Read cached models on mount / machine switch without spawning host or agent.
  useEffect(() => {
    const seq = ++reqRef.current;
    refreshAbortRef.current?.abort();
    refreshAbortRef.current = null;
    setRefreshing(false);
    setCached([]);
    setFetchedAt(undefined);
    setError(undefined);
    setHint(undefined);
    if (!targetMachine) {
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    void chatApi
      .models(targetMachine, kind, ac.signal)
      .then((res) => {
        if (seq !== reqRef.current || ac.signal.aborted) return;
        setCached(res.models);
        setFetchedAt(res.fetchedAt);
      })
      .catch((e: unknown) => {
        if (seq !== reqRef.current || ac.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
        // not_running / not_found means no cache yet; bad_request / unsupported comes from older hosts without Op.Models.
        if (
          e instanceof ChatFailure &&
          (e.code === 'not_running' || e.code === 'not_found' || e.code === 'bad_request' || e.code === 'unsupported')
        ) {
          return;
        }
        setError(failureText(e, agent, 'chat.settings.refreshFailed'));
      })
      .finally(() => {
        if (seq === reqRef.current && !ac.signal.aborted) setLoading(false);
      });
    return () => {
      ac.abort();
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = null;
    };
  }, [targetMachine, kind, agent]);

  const handleRefresh = useCallback(async () => {
    if (readOnly || !targetMachine || refreshing) return;
    const seq = ++reqRef.current;
    refreshAbortRef.current?.abort();
    const ac = new AbortController();
    refreshAbortRef.current = ac;
    setRefreshing(true);
    setError(undefined);
    setHint(undefined);
    try {
      const res = await chatApi.refreshModels(targetMachine, kind, undefined, ac.signal);
      if (seq !== reqRef.current || ac.signal.aborted) return;
      setCached(res.models);
      setFetchedAt(res.fetchedAt);
    } catch (e: unknown) {
      if (seq !== reqRef.current || ac.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
      if (e instanceof ChatFailure && e.code === 'not_found') {
        setError(t('conversation.error.start_not_found', { agent }));
      } else if (e instanceof ChatFailure && (e.code === 'probe_busy' || e.code === 'busy')) {
        setError(t('conversation.error.probe_busy', { agent }));
      } else {
        setError(failureText(e, agent, 'chat.settings.refreshFailed'));
      }
    } finally {
      if (refreshAbortRef.current === ac) refreshAbortRef.current = null;
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

  const cachedIds = useMemo(() => (cached.length > 0 ? cached.map((m) => m.value) : undefined), [cached]);
  const savedSet = useMemo(() => new Set(saved), [saved]);
  const allShown = !cleared && saved.length === 0;
  const isChecked = useCallback((id: string) => !cleared && (allShown || savedSet.has(id)), [cleared, allShown, savedSet]);
  const shownCount = cleared ? 0 : allShown ? allModels.length : allModels.filter((m) => savedSet.has(m.value)).length;

  const filteredModels = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allModels;
    return allModels.filter(
      (m) =>
        m.name.toLowerCase().includes(q) || m.value.toLowerCase().includes(q) || (m.description && m.description.toLowerCase().includes(q)),
    );
  }, [allModels, filter]);

  const hasFilter = filter.trim().length > 0;
  const targetModels = hasFilter ? filteredModels : allModels;
  const allTargetChecked = targetModels.length > 0 && targetModels.every((m) => isChecked(m.value));
  const anyTargetChecked = targetModels.some((m) => isChecked(m.value));

  const saveList = useCallback(
    async (next: string[]) => {
      setCleared(false);
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
      const cur = new Set(cleared ? [] : allShown ? allIds : saved);
      if (cur.has(id)) {
        cur.delete(id);
        if (cur.size === 0) {
          setCleared(true);
          setHint(t('chat.settings.keepOne'));
          return;
        }
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
    [readOnly, locked, allModels, cleared, allShown, saved, saveList],
  );

  const handleSelectAll = useCallback(() => {
    if (readOnly || locked) return;
    if (!hasFilter) {
      void saveList([]);
      return;
    }
    const allIds = allModels.map((m) => m.value);
    const cur = new Set(cleared ? [] : allShown ? allIds : saved);
    for (const m of filteredModels) cur.add(m.value);
    if (allIds.length > 0 && allIds.every((x) => cur.has(x))) {
      void saveList([]);
      return;
    }
    const ordered = allIds.filter((x) => cur.has(x));
    for (const x of cur) if (!ordered.includes(x)) ordered.push(x);
    void saveList(ordered);
  }, [readOnly, locked, hasFilter, allModels, cleared, allShown, saved, filteredModels, saveList]);

  const handleDeselectAll = useCallback(() => {
    if (readOnly || locked) return;
    if (!hasFilter) {
      setCleared(true);
      setHint(t('chat.settings.keepOne'));
      return;
    }
    const allIds = allModels.map((m) => m.value);
    const cur = new Set(cleared ? [] : allShown ? allIds : saved);
    for (const m of filteredModels) cur.delete(m.value);
    if (cur.size === 0) {
      setCleared(true);
      setHint(t('chat.settings.keepOne'));
      return;
    }
    const ordered = allIds.filter((x) => cur.has(x));
    for (const x of cur) if (!ordered.includes(x)) ordered.push(x);
    void saveList(ordered);
  }, [readOnly, locked, hasFilter, allModels, cleared, allShown, saved, filteredModels, saveList]);

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
      <div className="setting chat-provider-switch-row" data-key={switchKey}>
        <div className="setting-head">
          <span className="setting-title">{t('chat.settings.providerEnabled')}</span>
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={providerOn}
            aria-label={t('chat.settings.providerToggle', { agent })}
            disabled={readOnly || switchLocked}
            onClick={() => void setSetting(switchKey, !providerOn)}
          />
        </div>
        <div className="setting-desc">{t('chat.settings.providerEnabledDesc', { agent })}</div>
      </div>
      {modeDef && <div className="chat-provider-mode-row">{rows([modeDef])}</div>}
      <StartModelRow kind={kind} agent={agent} models={allModels} offered={cachedIds} readOnly={readOnly} />
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
        </div>
        <div className="setting-desc">{t('chat.settings.modelsDesc', { agent })}</div>
        {(fetchedAt || allModels.length > 0) && (
          <div className="chat-models-meta muted small">
            {allModels.length > 0 && <span>{t('chat.settings.modelsCount', { shown: shownCount, total: allModels.length })}</span>}
            {fetchedAt && <span>{t('chat.settings.refreshedAt', { when: formatTime(fetchedAt) })}</span>}
            {allModels.length > 0 && !disabled && (
              <span className="chat-models-bulk">
                <button
                  type="button"
                  className="ghost sm chat-models-select-all chat-models-show-all"
                  disabled={allTargetChecked}
                  onClick={handleSelectAll}
                >
                  {t(hasFilter ? 'chat.settings.selectShown' : 'chat.settings.selectAll')}
                </button>
                <button
                  type="button"
                  className="ghost sm chat-models-deselect-all"
                  disabled={!anyTargetChecked}
                  onClick={handleDeselectAll}
                >
                  {t(hasFilter ? 'chat.settings.deselectShown' : 'chat.settings.deselectAll')}
                </button>
              </span>
            )}
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
              const checked = isChecked(m.value);
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

/** The model a new chat of kind starts with (chat.model.<kind>): the agent's
 * default, the one chosen last, or a model of those known (models). A choice
 * that cannot start a chat now (hidden from the picker, or no longer in the
 * agent's list offered when it is known) stays chosen and says so, with the
 * model new chats start with instead. */
function StartModelRow({
  kind,
  agent,
  models,
  offered,
  readOnly,
}: {
  kind: string;
  agent: string;
  models: readonly ModelOption[];
  offered?: readonly string[];
  readOnly: boolean;
}) {
  const values = useSettings((s) => s.values);
  const [error, setError] = useState<string | undefined>();
  const key = `${MODEL_PREFIX}${kind}`;
  const disabled = readOnly || !!values[key]?.locked;
  const setting = startModelSetting(values, kind);
  const last = lastModelFor(values, kind);
  const name = (id: string) => models.find((m) => m.value === id)?.name || id;
  const why = (id: string) => modelUnavailable(values, kind, id, offered);
  const label = (id: string) => {
    const w = why(id);
    return w ? t(w === 'hidden' ? 'chat.settings.startModel.hidden' : 'chat.settings.startModel.withdrawn', { model: name(id) }) : name(id);
  };
  const ids = models.map((m) => m.value);
  if (setting !== '' && setting !== LAST_MODEL && !ids.includes(setting)) ids.unshift(setting);
  const chosen = setting === LAST_MODEL ? last : setting;
  const start = startModelOptions(values, kind, offered).model;
  const fallback = start ? name(start) : t('chat.settings.startModel.agentDefault');
  const note =
    chosen !== '' && why(chosen)
      ? t('chat.settings.startModel.unavailable', { model: name(chosen), fallback })
      : chosen === '' && start
        ? t('chat.settings.startModel.firstShown', { agent, fallback })
        : undefined;
  const change = async (v: string) => {
    setError(undefined);
    const err = v === '' ? await resetSetting(key) : await setSetting(key, v);
    if (err) setError(err);
  };
  return (
    <div className="setting chat-start-model" data-key={key}>
      <div className="setting-head">
        <span className="setting-title">{t('chat.settings.startModel')}</span>
      </div>
      <div className="setting-desc">{t('chat.settings.startModelDesc', { agent })}</div>
      <div className="setting-control">
        <select
          value={setting}
          disabled={disabled}
          aria-label={t('chat.settings.startModel')}
          onChange={(e) => void change(e.target.value)}
        >
          <option value="">{t('chat.settings.startModel.agent')}</option>
          <option value={LAST_MODEL}>
            {last ? t('chat.settings.startModel.lastIs', { model: label(last) }) : t('chat.settings.startModel.last')}
          </option>
          {ids.map((id) => (
            <option key={id} value={id} disabled={id !== setting && why(id) === 'hidden'}>
              {label(id)}
            </option>
          ))}
        </select>
      </div>
      {note && <p className="muted small chat-start-model-note">{note}</p>}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// The Agent Chats management/debug sections on the Settings page:
// 1) Headless Chat Hosts overview across machines (process status, counts,
//    active sessions, stop host / stop session / open chat controls).
// 2) Trusted Folders list per machine (persisted across refreshes, with
//    per-folder revoke controls).
import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderCheck, RefreshCw, Server, ShieldOff, Square, ExternalLink } from 'lucide-react';
import { relativeTime } from '../../conversation/format';
import { locale, t, type MessageKey } from '../../i18n';
import { formatSize } from '../../lib/files';
import { useStore } from '../../state/store';
import type { PluginSettingsProps } from '../api';
import { ChatFailure, chatApi, reasonText } from './api';
import { stateLabel } from './ChatHeader';
import { agentName, kindIcon, openChat } from './ops';
import type { ChatHostOverview, TrustedFolder } from './protocol';

function hostStatusLabel(status: ChatHostOverview['status']): string {
  const key = `chat.manage.hostStatus.${status}`;
  return t(key as MessageKey);
}

export function ChatSettingsExtra({ readOnly }: PluginSettingsProps) {
  const order = useStore((s) => s.order);
  const machines = useStore((s) => s.machines);
  const activeMachine = useStore((s) => s.machineId);

  // ---- Headless chat hosts overview ----
  const [hosts, setHosts] = useState<ChatHostOverview[]>();
  const [hostsLoading, setHostsLoading] = useState(false);
  const [hostsError, setHostsError] = useState('');
  const [busyHost, setBusyHost] = useState<string>();
  const [busySession, setBusySession] = useState<string>();

  const loadHosts = useCallback(async () => {
    setHostsLoading(true);
    setHostsError('');
    try {
      setHosts(await chatApi.hosts());
    } catch (e) {
      setHostsError(reasonText(e));
    } finally {
      setHostsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHosts();
  }, [loadHosts]);

  const stopHost = async (m: string) => {
    if (readOnly || busyHost) return;
    setBusyHost(m);
    setHostsError('');
    try {
      await chatApi.stopHost(m);
      await loadHosts();
    } catch (e) {
      setHostsError(reasonText(e));
    } finally {
      setBusyHost(undefined);
    }
  };

  const stopSession = async (m: string, chat: string) => {
    if (readOnly || busySession) return;
    const k = `${m}\n${chat}`;
    setBusySession(k);
    setHostsError('');
    try {
      await chatApi.close(m, chat);
      await loadHosts();
    } catch (e) {
      setHostsError(reasonText(e));
    } finally {
      setBusySession(undefined);
    }
  };

  // ---- Trusted folders management ----
  const defaultMachine = activeMachine && machines[activeMachine] ? activeMachine : order[0];
  const [trustedMachine, setTrustedMachine] = useState<string | undefined>(defaultMachine);
  useEffect(() => {
    if (!trustedMachine || !machines[trustedMachine]) setTrustedMachine(defaultMachine);
  }, [defaultMachine, trustedMachine, machines]);

  const [trustedData, setTrustedData] = useState<{ machine: string; folders: TrustedFolder[] }>();
  const [trustedLoading, setTrustedLoading] = useState(false);
  const [trustedError, setTrustedError] = useState('');
  const [revoking, setRevoking] = useState<string>();
  const trustedReqRef = useRef(0);

  const trusted = trustedData && trustedData.machine === trustedMachine ? trustedData.folders : undefined;
  const targetState = trustedMachine ? machines[trustedMachine] : undefined;
  const targetReady = targetState?.status === 'ready';

  const loadTrusted = useCallback(async () => {
    const reqId = ++trustedReqRef.current;
    const machine = trustedMachine;
    if (!machine) {
      setTrustedData(undefined);
      setTrustedError('');
      setTrustedLoading(false);
      return;
    }
    if (!targetReady) {
      setTrustedData(undefined);
      setTrustedError(t('chat.manage.machineOffline'));
      setTrustedLoading(false);
      return;
    }
    setTrustedLoading(true);
    setTrustedError('');
    try {
      let list: TrustedFolder[];
      try {
        list = await chatApi.trusted(machine);
      } catch (e) {
        if (e instanceof ChatFailure && e.code === 'not_running' && !readOnly) {
          if (reqId !== trustedReqRef.current) return;
          list = await chatApi.startTrusted(machine);
        } else {
          throw e;
        }
      }
      if (reqId !== trustedReqRef.current) return;
      setTrustedData({ machine, folders: list });
    } catch (e) {
      if (reqId !== trustedReqRef.current) return;
      setTrustedData(undefined);
      if (e instanceof ChatFailure && e.code === 'not_running' && readOnly) {
        setTrustedError(t('chat.manage.hostNotRunning'));
      } else {
        setTrustedError(reasonText(e));
      }
    } finally {
      if (reqId === trustedReqRef.current) setTrustedLoading(false);
    }
  }, [trustedMachine, targetReady, readOnly]);

  useEffect(() => {
    void loadTrusted();
  }, [loadTrusted]);

  const revoke = async (machine: string, cwd: string) => {
    if (readOnly || revoking || trustedLoading) return;
    const reqId = trustedReqRef.current;
    setRevoking(cwd);
    setTrustedError('');
    try {
      await chatApi.untrust(machine, cwd);
      useStore.getState().toast(t('chat.manage.revoked', { cwd }));
      if (reqId === trustedReqRef.current) await loadTrusted();
    } catch (e) {
      if (reqId === trustedReqRef.current) setTrustedError(reasonText(e));
    } finally {
      setRevoking(undefined);
    }
  };

  const now = Date.now();

  return (
    <div className="chat-manage" data-chat-manage>
      <div className="setting" data-chat-hosts>
        <div className="setting-head">
          <span className="setting-title">{t('chat.manage.hostsTitle')}</span>
          <button
            type="button"
            className="icon sm chat-manage-refresh"
            title={t('chat.manage.refresh')}
            aria-label={t('chat.manage.refresh')}
            disabled={hostsLoading}
            onClick={() => void loadHosts()}
          >
            <RefreshCw />
          </button>
        </div>
        <div className="setting-desc">{t('chat.manage.hostsDesc')}</div>
        {hostsError && <p className="error small">{hostsError}</p>}
        {hostsLoading && !hosts && <p className="muted small">{t('chat.manage.loading')}</p>}
        {hosts && hosts.length === 0 && <p className="muted small">{t('chat.manage.noHosts')}</p>}
        {hosts && hosts.length > 0 && (
          <div className="chat-manage-hosts">
            {hosts.map((h) => {
              const started = h.startedAt ? Date.parse(h.startedAt) : NaN;
              const stats = [
                h.pid ? t('chat.manage.pid', { pid: h.pid }) : undefined,
                h.version ? t('chat.manage.version', { version: h.version }) : undefined,
                h.liveAgents !== undefined ? t('chat.manage.liveAgents', { n: h.liveAgents }) : undefined,
                t('chat.manage.totalChats', { n: h.totalChats }),
                h.totalBytes !== undefined ? formatSize(h.totalBytes) : undefined,
                h.conns !== undefined ? t('chat.manage.conns', { n: h.conns }) : undefined,
                h.watchers !== undefined ? t('chat.manage.watchers', { n: h.watchers }) : undefined,
                Number.isFinite(started) ? t('chat.manage.started', { when: relativeTime(started / 1000, now, locale) }) : undefined,
              ].filter(Boolean);
              return (
                <div key={h.machine} className="chat-host-card" data-host={h.machine} data-status={h.status}>
                  <div className="chat-host-head">
                    <Server className="chat-host-icon" aria-hidden />
                    <span className="chat-host-name ellipsis">{h.label}</span>
                    <span className={`chat-host-badge st-${h.status}`}>{hostStatusLabel(h.status)}</span>
                    {!readOnly && h.running && (
                      <button
                        type="button"
                        className="sm danger-text chat-host-stop"
                        disabled={busyHost === h.machine}
                        onClick={() => void stopHost(h.machine)}
                      >
                        <Square aria-hidden /> {t('chat.manage.stopHost')}
                      </button>
                    )}
                  </div>
                  {stats.length > 0 && <div className="chat-host-stats small muted">{stats.join(' · ')}</div>}
                  {(h.error || h.message) && <div className="error small">{[h.error, h.message].filter(Boolean).join(': ')}</div>}
                  {h.sessions.length > 0 ? (
                    <div className="chat-host-sessions" role="list">
                      {h.sessions.map((s) => {
                        const Icon = kindIcon(s.kind);
                        const title = s.title || agentName(s.kind);
                        const label = stateLabel(s.state) ?? s.state;
                        const sk = `${h.machine}\n${s.chat}`;
                        return (
                          <div key={s.chat} className="chat-host-session" role="listitem" data-chat={s.chat}>
                            <Icon className="chat-host-session-icon" />
                            <div className="chat-host-session-info">
                              <div className="chat-host-session-title ellipsis">
                                {title}{' '}
                                <span className="muted small">
                                  · {label}
                                  {s.pid ? ` · ${t('chat.manage.pid', { pid: s.pid })}` : ''}
                                </span>
                              </div>
                              <div className="chat-host-session-meta small muted ellipsis">
                                {[s.cwd, formatSize(s.bytes)].filter(Boolean).join(' · ')}
                              </div>
                            </div>
                            <div className="chat-host-session-actions">
                              <button
                                type="button"
                                className="icon sm"
                                title={t('chat.manage.openChat')}
                                aria-label={t('chat.manage.openChat')}
                                onClick={() => {
                                  useStore.getState().openSettings(false);
                                  void openChat(h.machine, s.chat, s.kind);
                                }}
                              >
                                <ExternalLink />
                              </button>
                              {!readOnly && s.state !== 'closed' && (
                                <button
                                  type="button"
                                  className="sm"
                                  disabled={busySession === sk}
                                  onClick={() => void stopSession(h.machine, s.chat)}
                                >
                                  {t('chat.manage.stopSession')}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    h.running && <div className="muted small">{t('chat.manage.noSessions')}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="setting" data-chat-trusted>
        <div className="setting-head">
          <span className="setting-title">{t('chat.manage.trustedTitle')}</span>
          {order.length > 1 && (
            <select
              className="chat-trusted-machine"
              aria-label={t('chat.manage.machine')}
              value={trustedMachine ?? ''}
              onChange={(e) => setTrustedMachine(e.target.value)}
            >
              {order.map((id) => (
                <option key={id} value={id}>
                  {machines[id]?.label ?? id}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="icon sm chat-manage-refresh"
            title={t('chat.manage.refresh')}
            aria-label={t('chat.manage.refresh')}
            disabled={trustedLoading || !trustedMachine}
            onClick={() => void loadTrusted()}
          >
            <RefreshCw />
          </button>
        </div>
        <div className="setting-desc">{t('chat.manage.trustedDesc')}</div>
        {!trustedMachine && <p className="muted small">{t('chat.manage.noMachines')}</p>}
        {trustedError && <p className="error small">{trustedError}</p>}
        {trustedLoading && !trusted && <p className="muted small">{t('chat.manage.loading')}</p>}
        {trusted && trusted.length === 0 && !trustedError && <p className="muted small">{t('chat.manage.noTrusted')}</p>}
        {trusted && trusted.length > 0 && (
          <div className="chat-trusted-list" role="list">
            {trusted.map((f) => {
              const at = f.at ? Date.parse(f.at) : NaN;
              const when = Number.isFinite(at) ? t('chat.manage.trustedAt', { when: relativeTime(at / 1000, now, locale) }) : '';
              return (
                <div key={f.cwd} className="chat-trusted-row" role="listitem" data-cwd={f.cwd}>
                  <FolderCheck className="chat-trusted-icon" aria-hidden />
                  <div className="chat-trusted-info">
                    <div className="mono ellipsis" title={f.cwd}>
                      {f.cwd}
                    </div>
                    {when && (
                      <div className="muted small" title={f.at}>
                        {when}
                      </div>
                    )}
                  </div>
                  {!readOnly && trustedMachine && (
                    <button
                      type="button"
                      className="sm danger-text"
                      disabled={trustedLoading || revoking === f.cwd}
                      onClick={() => void revoke(trustedMachine, f.cwd)}
                    >
                      <ShieldOff aria-hidden /> {t('chat.manage.revoke')}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

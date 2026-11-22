// Reminds the user to restart a machine's chat host that is another build
// than the core's (StatesData.outdated): the host outlives the app, so
// after an update or a reinstalled local build the chats still run in the
// old one until it is restarted, which ends its agents. A machine's host
// is said once per page and host build, when none of its chats starts,
// works or waits; the Chats panel says it as long as it lasts
// (ChatsPanel.tsx). A read-only page says nothing: it cannot restart it.
import { t } from '../../i18n';
import { useStore } from '../../state/store';
import { machineLabel, restartHost } from './ops';
import { hostBusy, useChats, type ChatsState } from './state';

const reminded = new Set<string>();

/** Says each outdated host not said yet whose chats are all at rest. */
export function remindHosts(s: ChatsState = useChats.getState()) {
  if (useStore.getState().readOnly) return;
  for (const [m, h] of Object.entries(s.hosts ?? {})) {
    const key = `${m}\n${h.version}`;
    if (!h.outdated || reminded.has(key) || hostBusy(s, m)) continue;
    reminded.add(key);
    useStore
      .getState()
      .toast(
        t('chat.host.outdated', { machine: machineLabel(m), version: h.version }),
        { label: t('chat.host.restart'), run: () => void restartHost(m) },
        undefined,
        'info',
      );
  }
}

let unsubscribe: (() => void) | undefined;

/** Follows the chats' states to remind of outdated hosts. */
export function watchHosts() {
  unsubscribe ??= useChats.subscribe((s) => remindHosts(s));
}

/** Forgets what was said and stops following (tests). */
export function resetHostReminders() {
  reminded.clear();
  unsubscribe?.();
  unsubscribe = undefined;
}

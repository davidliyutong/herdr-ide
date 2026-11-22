// The quick switch in the header of a terminal's pane that runs a coding
// agent with a native view: shows which view is on (the conversation or
// the terminal) and flips it for every client of the machine (view.ts
// toggleView). It stays in narrow headers and in panes without the focus
// (agents.css). A read-only page shows it disabled; the view follows the
// layout there.

import { MessagesSquare, SquareTerminal } from 'lucide-react';
import { agentKind } from '../../conversation/kinds';
import { t } from '../../i18n';
import { withKey } from '../../keymap';
import { useStore } from '../../state/store';
import { useTerms } from '../../state/terms';
import type { HeaderActionsComponent } from '../api';
import { nativeKind, toggleView } from './view';
import './agents.css';

export const ViewToggle: HeaderActionsComponent = ({ m, terminal, leaf }) => {
  const kind = useTerms((s) => nativeKind(s.machines[m]?.terminals[terminal]));
  const readOnly = useStore((s) => s.readOnly);
  if (!kind) return null;
  const native = leaf.render === 'native';
  const agent = agentKind(kind)?.title ?? kind;
  const action = t(native ? 'agents.view.toTerminal' : 'agents.view.toConversation', { agent });
  const title = readOnly
    ? t(native ? 'agents.view.onReadOnly' : 'agents.view.offReadOnly', { agent })
    : withKey(action, 'agents.toggleView');
  return (
    <button
      type="button"
      className="agents-toggle"
      data-on={native || undefined}
      aria-pressed={native}
      aria-label={t('agents.view.label', { agent })}
      title={title}
      disabled={readOnly}
      tabIndex={-1}
      onClick={() => toggleView(m, terminal)}
    >
      {native ? <MessagesSquare aria-hidden /> : <SquareTerminal aria-hidden />}
    </button>
  );
};

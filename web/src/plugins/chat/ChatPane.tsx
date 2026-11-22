// The chat pane. This version has no chat host on the machines: the pane
// says so.
import { t } from '../../i18n';

export function ChatPane() {
  return (
    <div className="empty-state">
      <div>{t('chat.unavailable')}</div>
    </div>
  );
}

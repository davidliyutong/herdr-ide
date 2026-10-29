import type { AgentStatus } from '../lib/herdr';
import { t } from '../i18n';

export function statusLabel(s: AgentStatus): string {
  return t(`status.${s}`);
}

export function StatusDot({ status, title }: { status?: AgentStatus | null; title?: string }) {
  const s = status ?? 'unknown';
  return <span className={`dot dot-${s}`} title={title ?? statusLabel(s)} />;
}

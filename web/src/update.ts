// After the core is replaced, a page loaded from the old build keeps running
// its old code against the new core (settings it has no labels for, missing
// features). On every reconnect the page compares its entry script with the
// one the core serves now and offers to reload.

import { useStore } from './state/store';
import { t } from './i18n';

function entry(doc: Document): string | undefined {
  return doc.querySelector('script[type="module"][src]')?.getAttribute('src') ?? undefined;
}

export function initUpdateCheck() {
  const mine = entry(document);
  if (!mine) return;
  let offered = false;
  let was = useStore.getState().connected;
  const check = async () => {
    try {
      const html = await (await fetch('/', { cache: 'no-store' })).text();
      const now = entry(new DOMParser().parseFromString(html, 'text/html'));
      if (!now || now === mine || offered) return;
      offered = true;
      useStore.getState().toast(t('app.updated'), { label: t('app.reload'), run: () => location.reload(), sticky: true });
    } catch {
      // Checked again at the next reconnect.
    }
  };
  useStore.subscribe((s) => {
    if (s.connected && !was) void check();
    was = s.connected;
  });
}

// Opening what a pane's output names (links.ts): media in a preview pane and
// code files in a VS Code pane, beside the terminal or in one its workspace
// has; web addresses in a browser pane or outside the app. A document's web
// links (markdown/MarkdownBody.tsx) open the same way.

import { actions } from '../actions';
import { isPluginOn } from '../plugins/registry';
import { safeWebUrl } from '../lib/webUrl';
import { settingValue } from '../settings';
import { forwardsAvailable, linkMode, linkPlace, openBrowserTab, useForwards } from '../plugins/browser/api';
import { resolvePath, type FoundLink, type LinkContext } from './links';

/**
 * Opens a web address the user clicked in a text of machine m, when it is
 * one a text may open (safeWebUrl): with the browser plugin on, by
 * browser.openLinks (plugins/browser/api.ts linkPlace): by default a
 * loopback address in a browser pane of a new tab, a remote machine's
 * through its forward when this client can use one, and any other address
 * outside the app, in a tab of the browser (the system's browser in the
 * desktop app). With the plugin off, outside. A terminal's link, clicked
 * with Cmd/Ctrl under a tooltip that names it, is the user asking for the
 * machine's port; with ask (a document's link, a plain click on a text that
 * may hide its address) the pane asks before it makes a forward
 * (openBrowserTab).
 */
export function openWebLink(href: string, m: string, opts: { ask?: boolean } = {}) {
  const url = safeWebUrl(href);
  if (url === undefined) return;
  // No referrer: the UI's address is nothing for the site to know.
  const outside = () => void window.open(url, '_blank', 'noopener,noreferrer');
  if (!isPluginOn('browser')) return outside();
  const pane = () => void openBrowserTab(m, url, opts);
  const place = linkPlace(m, url, linkMode(settingValue('browser.openLinks')));
  if (place === 'pane') return pane();
  if (place === 'outside') return outside();
  // Whether forwards can be used is the hub's word: known once asked.
  const decide = (available: boolean) => (available ? pane() : outside());
  const known = useForwards.getState().available;
  if (known !== undefined) {
    decide(known);
  } else void forwardsAvailable().then(decide);
}

/** Opens a URL in a new tab, or a path in the File Explorer preview (default)
 * or VS Code (files.openLinks). */
export function openLink(l: { kind: FoundLink['kind']; text: string }, ctx: LinkContext) {
  // Targets come from pane output (OSC 8): web links only.
  if (l.kind === 'url') return openWebLink(l.text, ctx.m);
  const r = resolvePath(l.text, ctx);
  void actions.openPath(ctx.m, r.path, r.line, r.col, ctx.pane, r.endLine, r.endCol);
}

// The page the macOS application shows a formula in when the pointer rests
// on one in a terminal (docs/features/19-formulas-in-panes.md): the web
// UI's KaTeX rendering, with the page's size reported to the application
// as it changes (KaTeX's fonts arrive after the first layout).

import { renderMath } from './terminal/mathRender';
import './tokens.css';
import './mathPage.css';

interface Handlers {
  size?: { postMessage(size: { w: number; h: number }): void };
}

declare global {
  interface Window {
    /** Renders a formula; false when KaTeX cannot read it. */
    render(tex: string, display: boolean, dark: boolean): Promise<boolean>;
    webkit?: { messageHandlers?: Handlers };
  }
}

const box = document.getElementById('math')!;

function report() {
  const r = box.getBoundingClientRect();
  window.webkit?.messageHandlers?.size?.postMessage({ w: Math.ceil(r.width), h: Math.ceil(r.height) });
}

new ResizeObserver(report).observe(box);

window.render = async (tex, display, dark) => {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const html = await renderMath(tex, display);
  box.innerHTML = html ?? '';
  report();
  return html !== null;
};

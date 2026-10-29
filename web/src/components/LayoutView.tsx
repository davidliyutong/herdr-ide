import { useRef, useState } from 'react';
import type { LayoutExport, LayoutNode } from '../lib/herdr';
import { conn } from '../lib/conn';
import { PaneView } from './PaneView';

interface Props {
  m: string;
  layout: LayoutExport;
}

export function LayoutView({ m, layout }: Props) {
  if (layout.zoomed && layout.focused_pane_id) {
    return (
      <div className="layout-root">
        <PaneView m={m} paneId={layout.focused_pane_id} zoomed />
      </div>
    );
  }
  return (
    <div className="layout-root">
      <NodeView m={m} tabId={layout.tab_id} node={layout.root} path={[]} />
    </div>
  );
}

function NodeView({ m, tabId, node, path }: { m: string; tabId: string; node: LayoutNode; path: boolean[] }) {
  if (node.type === 'pane') return <PaneView m={m} paneId={node.pane_id} />;
  return <SplitView m={m} tabId={tabId} node={node} path={path} />;
}

function SplitView({ m, tabId, node, path }: { m: string; tabId: string; node: Extract<LayoutNode, { type: 'split' }>; path: boolean[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | undefined>();
  const horizontal = node.direction === 'right';
  const ratio = drag ?? node.ratio;

  const onPointerDown = (ev: React.PointerEvent) => {
    ev.preventDefault();
    const el = ref.current!;
    const rect = el.getBoundingClientRect();
    (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
    let last = ratio;
    const move = (e: PointerEvent) => {
      const r = horizontal ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
      last = Math.min(0.95, Math.max(0.05, r));
      setDrag(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      conn
        .api(m, 'layout.set_split_ratio', { tab_id: tabId, path, ratio: last })
        .catch((e) => console.warn('set_split_ratio', e))
        .finally(() => setTimeout(() => setDrag(undefined), 300));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div ref={ref} className={`split ${horizontal ? 'split-h' : 'split-v'}`}>
      <div className="split-child" style={{ flexBasis: `${ratio * 100}%` }}>
        <NodeView m={m} tabId={tabId} node={node.first} path={[...path, false]} />
      </div>
      <div className="split-divider" onPointerDown={onPointerDown} />
      <div className="split-child" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
        <NodeView m={m} tabId={tabId} node={node.second} path={[...path, true]} />
      </div>
    </div>
  );
}

// Status bar indicator (bottom right, floating upward on hover or click) and
// the left-sidebar Cmd+hover dashboard overlay. Both render the exact same
// DashboardCard component so every machine shows identical live resource stats.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity } from 'lucide-react';
import { useSettings } from '../../settings';
import { useStore } from '../../state/store';
import { useDismiss } from '../../components/useDismiss';
import { HOVER_CLOSE_MS, useHoverOpen } from '../../components/useHoverOpen';
import { t } from '../../i18n';
import { DashboardCard } from './DashboardCard';
import { formatPct, metricLevel, peakGpuPct, pointInSafeCorridor, type Point2D } from './model';
import { fetchMetrics, useMonitor } from './state';

const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);
const CMD_HOVER_OPEN_MS = 80;
const CMD_HOVER_SWITCH_MS = 180;
const CARD_LEAVE_CLOSE_MS = 220;

function refreshMs(val: unknown): number {
  const sec = typeof val === 'number' && Number.isFinite(val) ? val : 2;
  return Math.max(1, Math.min(30, sec)) * 1000;
}

function hasHoverModifier(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return IS_MAC ? e.metaKey : e.metaKey || e.ctrlKey;
}

function isModifierKey(key: string): boolean {
  return IS_MAC ? key === 'Meta' : key === 'Meta' || key === 'Control';
}

export function MonitorStatusItem() {
  const shown = useSettings((s) => s.values['monitor.statusBar']?.value !== false);
  const intervalMs = useSettings((s) => refreshMs(s.values['monitor.refreshSeconds']?.value));
  const machineId = useStore((s) => s.machineId);
  const machine = useStore((s) => (s.machineId ? s.machines[s.machineId] : undefined));
  const metrics = useMonitor((s) => (machineId ? s.machines[machineId]?.metrics : undefined));

  const [open, setOpen] = useState(false);
  const hover = useHoverOpen(open, setOpen);
  const card = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();

  const close = useCallback(() => {
    hover.cancel();
    setOpen(false);
  }, [hover]);

  useDismiss(open, card, close, btn);

  const active = shown || open;

  // Poll the active machine while the status bar item or its popup is visible.
  useEffect(() => {
    if (!machineId || machine?.status !== 'ready' || !active) return;
    const ac = new AbortController();
    const poll = () => {
      if (ac.signal.aborted || document.hidden) return;
      void fetchMetrics(machineId, ac.signal);
    };
    poll();
    const timer = setInterval(poll, intervalMs);
    const onVis = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      ac.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [machineId, machine?.status, active, intervalMs]);

  // Keep the upward-floating menu within the viewport's left edge.
  useLayoutEffect(() => {
    const el = card.current;
    if (!el || !open) return;
    el.style.transform = '';
    const left = el.getBoundingClientRect().left;
    if (left < 8) el.style.transform = `translateX(${8 - left}px)`;
  });

  const gpuPeak = peakGpuPct(metrics?.gpus);
  const topPct = Math.max(metrics?.cpu.usagePct ?? 0, metrics?.memory.usedPct ?? 0, gpuPeak ?? 0);
  const level = metrics ? metricLevel(topPct) : 'ok';

  if (!shown || !machineId || !machine) return null;

  return (
    <span className="gui-menu-anchor monitor-status-anchor" {...hover.anchor}>
      <button
        ref={btn}
        className={`monitor-status-item level-${level}`}
        aria-label={t('monitor.statusTitle', { machine: machine.label })}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={t('monitor.statusTitle', { machine: machine.label })}
        onClick={() => {
          if (open && hover.hover) {
            hover.pin();
          } else {
            hover.cancel();
            setOpen((v) => !v);
          }
        }}
      >
        <Activity />
        {metrics ? (
          <span className="monitor-status-nums">
            <span className="monitor-status-metric">
              <span>{t('monitor.cpu')}</span>
              <span className="monitor-status-val">{formatPct(metrics.cpu.usagePct)}</span>
            </span>
            <span className="monitor-dot">·</span>
            <span className="monitor-status-metric">
              <span>{t('monitor.memory')}</span>
              <span className="monitor-status-val">{formatPct(metrics.memory.usedPct)}</span>
            </span>
            {gpuPeak !== undefined && (
              <>
                <span className="monitor-dot">·</span>
                <span className="monitor-status-metric">
                  <span>{t('monitor.gpu')}</span>
                  <span className="monitor-status-val">{formatPct(gpuPeak)}</span>
                </span>
              </>
            )}
          </span>
        ) : (
          <span>{t('monitor.statusLabel')}</span>
        )}
      </button>
      {open && (
        <div
          ref={card}
          id={id}
          className="gui-menu monitor-popover"
          role="dialog"
          aria-label={t('monitor.statusTitle', { machine: machine.label })}
        >
          <DashboardCard machineId={machineId} onClose={close} />
        </div>
      )}
    </span>
  );
}

interface HoveredMachine {
  id: string;
  rect: DOMRect;
}

/** Shows the DashboardCard beside a left-sidebar machine row while the user
 * holds Cmd (Ctrl/Meta on Windows/Linux) and hovers that machine, protecting
 * pointer movement from the sidebar to the floating card with an invisible
 * gap bridge, an aiming-triangle corridor and a close grace delay. */
export function MachineHoverMonitor() {
  const intervalMs = useSettings((s) => refreshMs(s.values['monitor.refreshSeconds']?.value));
  const [shown, setShown] = useState<HoveredMachine | null>(null);
  const shownRef = useRef<HoveredMachine | null>(null);
  shownRef.current = shown;

  const hoveredRef = useRef<HoveredMachine | null>(null);
  const lastPointerRef = useRef<Point2D | null>(null);
  const anchorPointRef = useRef<Point2D | null>(null);
  const inCorridorRef = useRef(false);
  const overCardRef = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const switchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [pos, setPos] = useState<{ left: number; top: number; bridgeLeft: boolean } | undefined>();

  const clearOpen = useCallback(() => {
    clearTimeout(openTimer.current);
    openTimer.current = undefined;
  }, []);

  const clearClose = useCallback(() => {
    clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  }, []);

  const clearSwitch = useCallback(() => {
    clearTimeout(switchTimer.current);
    switchTimer.current = undefined;
  }, []);

  const clearTimers = useCallback(() => {
    clearOpen();
    clearClose();
    clearSwitch();
  }, [clearOpen, clearClose, clearSwitch]);

  const close = useCallback(() => {
    clearTimers();
    overCardRef.current = false;
    inCorridorRef.current = false;
    setShown(null);
  }, [clearTimers]);

  const scheduleClose = useCallback(
    (ms = HOVER_CLOSE_MS) => {
      clearOpen();
      clearSwitch();
      clearClose();
      closeTimer.current = setTimeout(() => {
        closeTimer.current = undefined;
        if (!overCardRef.current) {
          inCorridorRef.current = false;
          setShown(null);
        }
      }, ms);
    },
    [clearOpen, clearSwitch, clearClose],
  );

  useEffect(() => {
    const readMachineHead = (target: EventTarget | null): HoveredMachine | null => {
      if (!(target instanceof Element)) return null;
      const head = target.closest<HTMLElement>('[data-machine-head]');
      if (!head) return null;
      const box = head.closest<HTMLElement>('[data-machine]');
      const id = box?.dataset.machine;
      if (!id) return null;
      return { id, rect: head.getBoundingClientRect() };
    };

    const inSafeCorridor = (e: PointerEvent): boolean => {
      const origin = anchorPointRef.current;
      const surface = surfaceRef.current;
      if (!origin || !surface || !shownRef.current) return false;
      return pointInSafeCorridor({ x: e.clientX, y: e.clientY }, origin, surface.getBoundingClientRect());
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;

      const prevPt = lastPointerRef.current;
      const curPt: Point2D = { x: e.clientX, y: e.clientY };
      lastPointerRef.current = curPt;

      const inCard = !!(cardRef.current && e.target instanceof Node && cardRef.current.contains(e.target));
      overCardRef.current = inCard;
      if (inCard) {
        inCorridorRef.current = false;
        clearTimers();
        return;
      }

      const hit = readMachineHead(e.target);
      hoveredRef.current = hit;

      // Never open while dragging or holding a mouse button (e.g. Cmd+click multi-select).
      if (e.buttons !== 0) {
        clearOpen();
        return;
      }

      const cur = shownRef.current;
      const mod = hasHoverModifier(e);
      const corridor = cur ? inSafeCorridor(e) : false;
      const movingTowardCard = !prevPt || curPt.x >= prevPt.x - 2;
      inCorridorRef.current = corridor && movingTowardCard;

      if (hit && mod) {
        clearClose();
        if (!cur) {
          anchorPointRef.current = curPt;
          if (!openTimer.current) {
            openTimer.current = setTimeout(() => {
              openTimer.current = undefined;
              if (hoveredRef.current?.id === hit.id) setShown(hoveredRef.current);
            }, CMD_HOVER_OPEN_MS);
          }
          return;
        }
        if (cur.id === hit.id) {
          clearSwitch();
          anchorPointRef.current = curPt;
          return;
        }
        // Moving across another machine row while aiming diagonally inside the
        // virtual triangle toward the open card: delay switching so diagonal
        // travel does not hijack the card.
        if (corridor && movingTowardCard) {
          clearSwitch();
          switchTimer.current = setTimeout(() => {
            switchTimer.current = undefined;
            if (hoveredRef.current?.id === hit.id) {
              anchorPointRef.current = lastPointerRef.current ?? curPt;
              setShown(hoveredRef.current);
            }
          }, CMD_HOVER_SWITCH_MS);
        } else {
          clearSwitch();
          anchorPointRef.current = curPt;
          setShown(hit);
        }
        return;
      }

      // Pointer left machine rows (or Cmd released while moving): if a card is
      // open, protect movement across the gap / virtual triangle with a grace timer.
      clearOpen();
      clearSwitch();
      if (cur) {
        if (corridor && movingTowardCard) {
          // Keep refreshing the grace window while actively moving toward the card.
          scheduleClose(HOVER_CLOSE_MS);
        } else if (!closeTimer.current) {
          scheduleClose(HOVER_CLOSE_MS);
        }
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!shownRef.current) return;
      if (cardRef.current && e.target instanceof Node && cardRef.current.contains(e.target)) return;
      close();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        return;
      }
      if (!isModifierKey(e.key)) return;
      const hit = hoveredRef.current;
      if (hit) {
        clearTimers();
        anchorPointRef.current = lastPointerRef.current ?? { x: hit.rect.left, y: (hit.rect.top + hit.rect.bottom) / 2 };
        setShown(hit);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!isModifierKey(e.key)) return;
      if (overCardRef.current) return;
      // If the user is actively moving through the safe corridor toward the card,
      // let the close grace timer finish instead of snapping shut mid-travel.
      if (shownRef.current && inCorridorRef.current) {
        scheduleClose(HOVER_CLOSE_MS);
        return;
      }
      close();
    };

    const onBlur = () => {
      hoveredRef.current = null;
      anchorPointRef.current = null;
      close();
    };

    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      clearTimers();
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [clearTimers, clearOpen, clearClose, clearSwitch, close, scheduleClose]);

  // Poll live metrics for the hovered machine while its card is open.
  const shownId = shown?.id;
  const shownStatus = useStore((s) => (shownId ? s.machines[shownId]?.status : undefined));
  useEffect(() => {
    if (!shownId || shownStatus !== 'ready') return;
    const ac = new AbortController();
    const poll = () => {
      if (ac.signal.aborted || document.hidden) return;
      void fetchMetrics(shownId, ac.signal);
    };
    poll();
    const timer = setInterval(poll, intervalMs);
    return () => {
      ac.abort();
      clearInterval(timer);
    };
  }, [shownId, shownStatus, intervalMs]);

  // Position flush against the right edge of the hovered machine row (the outer
  // wrapper's left padding creates the visual 8 px gap while keeping hover unbroken).
  useLayoutEffect(() => {
    const el = surfaceRef.current;
    if (!el || !shown) return;
    const place = () => {
      const w = el.offsetWidth || 350;
      const h = el.offsetHeight || 280;
      const fitsRight = shown.rect.right + 8 + w <= window.innerWidth - 8;
      const left = fitsRight ? shown.rect.right : Math.max(8, window.innerWidth - w - 8);
      const top = Math.max(8, Math.min(shown.rect.top - 6, window.innerHeight - h - 8));
      setPos({ left, top, bridgeLeft: fitsRight });
    };
    place();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown]);

  if (!shown) return null;

  return createPortal(
    <div
      ref={cardRef}
      className={`monitor-hover-card ${pos?.bridgeLeft === false ? 'no-bridge' : ''}`}
      role="dialog"
      aria-label={t('monitor.title')}
      style={pos ? { left: pos.left, top: pos.top } : { left: shown.rect.right, top: shown.rect.top, visibility: 'hidden' }}
      onPointerEnter={() => {
        overCardRef.current = true;
        inCorridorRef.current = false;
        clearTimers();
      }}
      onPointerLeave={(e) => {
        overCardRef.current = false;
        if (!hasHoverModifier(e)) scheduleClose(CARD_LEAVE_CLOSE_MS);
      }}
    >
      <div ref={surfaceRef} className="monitor-hover-surface">
        <DashboardCard machineId={shown.id} onClose={close} />
      </div>
    </div>,
    document.body,
  );
}

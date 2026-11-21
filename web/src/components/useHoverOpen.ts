import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

/** How long the mouse rests on an anchor before its popup opens, and how
 * long it may be away (the gap between a button and its popup) before the
 * popup closes. */
export const HOVER_OPEN_MS = 200;
export const HOVER_CLOSE_MS = 300;

export interface HoverOpen {
  /** Whether the popup is open by hover alone: it closes when the mouse
   * leaves, until pin() keeps it. */
  hover: boolean;
  /** Keeps a popup opened by hover open after the mouse leaves. */
  pin(): void;
  /** Cancels a pending open or close (a click decides itself). */
  cancel(): void;
  /** For the element that holds the button and the popup. */
  anchor: {
    onPointerEnter(e: PointerEvent): void;
    onPointerLeave(e: PointerEvent): void;
  };
}

/** The open state of a popup that opens when the mouse rests on its anchor
 * and closes when it leaves (touch and pen keep to clicks). A popup that
 * `open` without the hover having opened it (a click, other code) counts as
 * pinned. Timers end with the component. */
export function useHoverOpen(open: boolean, setOpen: (open: boolean) => void): HoverOpen {
  const [hover, setHover] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef({ open, hover, setOpen });
  latest.current = { open, hover, setOpen };
  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  useEffect(() => cancel, [cancel]);
  // Closed by anything, it is no longer one of the hover's.
  useEffect(() => {
    if (!open) setHover(false);
  }, [open]);
  const onPointerEnter = useCallback(
    (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      cancel();
      if (latest.current.open) return;
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setHover(true);
        latest.current.setOpen(true);
      }, HOVER_OPEN_MS);
    },
    [cancel],
  );
  const onPointerLeave = useCallback(
    (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      cancel();
      if (!latest.current.open || !latest.current.hover) return;
      timer.current = setTimeout(() => {
        timer.current = undefined;
        latest.current.setOpen(false);
      }, HOVER_CLOSE_MS);
    },
    [cancel],
  );
  const pin = useCallback(() => {
    cancel();
    setHover(false);
  }, [cancel]);
  return { hover, pin, cancel, anchor: { onPointerEnter, onPointerLeave } };
}

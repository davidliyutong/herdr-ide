import { useEffect, type RefObject } from 'react';

/** Closes a popup on a press outside ref's element or on Escape. A press
 * on owner's element (the button that opens the popup, which toggles it
 * itself) is not outside. */
export function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void, owner?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const at = e.target as Node;
      if (!ref.current?.contains(at) && !owner?.current?.contains(at)) close();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
    };
  }, [open, ref, close, owner]);
}

/** Gives the keyboard back to what had it (a terminal, a button) once a
 * popup or dialog that took it closes (open turns false or it unmounts),
 * unless the user has put it somewhere else meanwhile. */
export function useReturnFocus(open: boolean) {
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement;
    return () => {
      const now = document.activeElement;
      const lost = !now || now === document.body || !now.isConnected;
      if (lost && before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true });
    };
  }, [open]);
}

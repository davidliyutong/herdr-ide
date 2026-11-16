// A collapsible group of a panel (Git's Staged Changes and Changes, a
// list's parts): a header with a chevron, the title, actions shown while
// it is pointed at or has the keyboard, and a count; whether it is open is
// kept per browser by its id (state/store.ts loadPref and savePref,
// section.<id>), and sections of one id open and close together.

import { useCallback, useId, useMemo, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { create } from 'zustand';
import { loadPref, savePref } from '../../state/store';

const useOpen = create<Record<string, boolean>>(() => ({}));

/** Whether the section id is open (kept per browser), and its setter. */
export function useSectionOpen(id: string, defaultOpen = true): [boolean, (open: boolean) => void] {
  const set = useOpen((s) => s[id]);
  const saved = useMemo(() => loadPref<boolean>(`section.${id}`, defaultOpen), [id, defaultOpen]);
  const setOpen = useCallback(
    (open: boolean) => {
      savePref(`section.${id}`, open);
      useOpen.setState({ [id]: open });
    },
    [id],
  );
  return [set ?? saved, setOpen];
}

export interface SectionProps {
  /** Names the section where its state is kept: a plugin's id first
   * (git.staged). */
  id: string;
  title: string;
  /** Shown at the header's end (neutral, as VS Code's counts). */
  count?: number;
  /** Buttons of the header (Stage All). */
  actions?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Section({ id, title, count, actions, defaultOpen = true, className, children }: SectionProps) {
  const [open, setOpen] = useSectionOpen(id, defaultOpen);
  const body = useId();
  return (
    <section className={['tree-section', open && 'open', className].filter(Boolean).join(' ')} aria-label={title}>
      <div className="section-head">
        <button type="button" className="section-toggle" aria-expanded={open} aria-controls={body} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown /> : <ChevronRight />}
          <span className="ellipsis">{title}</span>
        </button>
        {actions && <span className="section-actions">{actions}</span>}
        {count !== undefined && <span className="section-count">{count}</span>}
      </div>
      {open && (
        <div id={body} className="section-body">
          {children}
        </div>
      )}
    </section>
  );
}

// Trees and lists of panels (the file explorer, Git's changes): rows,
// their selection and keys, collapsible sections. Windowing is
// lib/windowed.ts, file icons fileIcons.tsx, match highlights
// components/Highlight.tsx.
export { TreeRow, type TreeRowProps, type RowDecoration } from './TreeRow';
export { Section, useSectionOpen, type SectionProps } from './Section';
export {
  TypeAhead,
  clickSelection,
  navigationKey,
  rangeOf,
  selectAll,
  selectOnly,
  selectRange,
  selectToggle,
  stepId,
  type KeyLike,
  type NavAction,
  type NavOptions,
  type NavRow,
  type Selection,
} from './selection';

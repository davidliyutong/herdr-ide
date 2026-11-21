// A row of a tree or list, as VS Code's explorer draws one: indent guides
// down to its depth, a twisty for a branch, an icon, the label (with the
// characters a filter matched marked), a description, actions shown while
// the row is pointed at or has the keyboard, and a decoration (a letter in
// its color, as version control marks files). The state classes
// (selected, cursor, drop target, dimmed) are styled in styles/tree.css (.tree-row).
// Every other attribute is the caller's: role, data-*, the handlers of
// clicks, the context menu and drags (draggable, onDragStart, onDragOver,
// onDrop), the style that places a windowed row.

import type { HTMLAttributes, ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Highlight } from '../Highlight';
import type { MatchRange } from '../../lib/match';

/** What another part of the app says about a row (version control): a
 * letter or two at its end, their and the label's color, a tooltip. */
export interface RowDecoration {
  badge?: string;
  /** A CSS color (a variable such as var(--ds-git-modified)). */
  color?: string;
  tooltip?: string;
}

export interface TreeRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** 0 for the top level; one indent guide per level above. */
  depth: number;
  /** A branch's state; undefined for a leaf, which has no twisty. */
  expanded?: boolean;
  /** A press on the twisty (not passed to the row's own onClick); without
   * it a press there is the row's. */
  onToggle?(): void;
  icon?: ReactNode;
  label: string;
  /** The characters of the label a filter matched. */
  highlight?: readonly MatchRange[];
  /** Muted text after the label (a folder of a path, a count). */
  description?: ReactNode;
  decoration?: RowDecoration;
  /** Buttons shown while the row is pointed at or has the keyboard. */
  actions?: ReactNode;
  /** Replaces the label: an inline rename. */
  editor?: ReactNode;
  selected?: boolean;
  /** The keyboard's row. */
  cursor?: boolean;
  /** Dragged rows would land in it. */
  dropTarget?: boolean;
  /** Drawn faint (cut to the clipboard). */
  dimmed?: boolean;
  /** Indent guides (on by default). */
  guides?: boolean;
}

export function TreeRow({
  depth,
  expanded,
  onToggle,
  icon,
  label,
  highlight,
  description,
  decoration,
  actions,
  editor,
  selected,
  cursor,
  dropTarget,
  dimmed,
  guides = true,
  className,
  ...rest
}: TreeRowProps) {
  const classes = ['tree-row', selected && 'selected', cursor && 'cursor', dropTarget && 'drop', dimmed && 'dimmed', className];
  const color = decoration?.color ? { color: decoration.color } : undefined;
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={expanded}
      aria-selected={selected ?? false}
      {...rest}
      className={classes.filter(Boolean).join(' ')}
    >
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} className={guides ? 'tree-guide' : 'tree-indent'} aria-hidden />
      ))}
      <span
        className="tree-twisty"
        aria-hidden
        onClick={
          onToggle && expanded !== undefined
            ? (e) => {
                e.stopPropagation();
                onToggle();
              }
            : undefined
        }
      >
        {expanded !== undefined && (expanded ? <ChevronDown /> : <ChevronRight />)}
      </span>
      {icon}
      {editor ?? (
        <span className="tree-text">
          <span className="tree-label ellipsis" style={color}>
            <Highlight text={label} ranges={highlight} />
          </span>
          {description !== undefined && <span className="tree-description ellipsis">{description}</span>}
        </span>
      )}
      {actions && !editor && (
        <span className="tree-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
      )}
      {decoration?.badge && (
        <span className="tree-badge" style={color}>
          {decoration.badge}
        </span>
      )}
    </div>
  );
}

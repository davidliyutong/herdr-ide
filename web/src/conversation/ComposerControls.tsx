// Controls around the conversation composer (Composer.tsx):
// - PlusMenu: `+` button inside the input pill merging workspace file picker,
//   image attachment picker, and Markdown preview toggle.
// - ModelEffortSelect: combined bottom-right trigger (`Opus 5.5 Medium`) whose
//   popover lists models for this session and opens an Effort flyout submenu.
// - ConfigSelect: permission mode (or standalone config) selector with
//   full-access gating and upward-preferred popover placement.
// - ContextRing (exported as UsageLine too): circular SVG context-window ring
//   with hover details card (session tokens, percentage, cost) and click-to-
//   compact confirmation.

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight, Eye, ImagePlus, LoaderCircle, Paperclip, Pencil, Plus } from 'lucide-react';
import { useDismiss } from '../components/useDismiss';
import { locale, t } from '../i18n';
import { formatBytes } from './attach';
import { contextPercent, formatCost, formatTokens } from './format';
import { MAX_IMAGE, type Usage } from './model';
import type { ConfigOption, ConfigValue } from '../plugins/chat/protocol';

/** A mode's name in the view's words when it is one of the host's. */
export function modeName(v: ConfigValue): string {
  switch (v.value) {
    case 'default':
    case 'acceptEdits':
    case 'plan':
    case 'auto':
    case 'full':
      return t(`conversation.mode.${v.value}`);
    case 'accept-edits':
    case 'accept_edits':
      return t('conversation.mode.acceptEdits');
    case 'bypassPermissions':
    case 'full-access':
    case 'full_access':
      return t('conversation.mode.full');
    default:
      return v.name;
  }
}

/** An effort level's display name: clarifies ambiguous provider labels such
 * as Antigravity's "Extra" for value "xhigh" while keeping clear names intact. */
export function effortName(v: ConfigValue): string {
  if (v.value === 'xhigh' && (!v.name || v.name.toLowerCase() === 'extra' || v.name === 'xhigh')) return 'XHigh';
  return v.name;
}

/** Why the values that give an agent full access (ConfigValue.full) are
 * not offered: the machine's settings do not allow it, or the view is
 * read-only. */
export type FullBlocked = 'off' | 'readOnly' | undefined;

export interface ConfigMenuPlace {
  placement: 'top' | 'bottom';
  left: number;
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

/** Places a popover below or above its trigger button, preferring upward
 * placement when near the bottom of the viewport. */
export function placeConfigMenu(
  anchor: { left: number; top: number; right: number; bottom: number },
  wanted: number,
  view: { width: number; height: number },
  maxWidthLimit = 340,
  minWidthFloor = 160,
  align: 'left' | 'right' = 'left',
): ConfigMenuPlace {
  const margin = 8;
  const gap = 6;
  const availW = Math.max(0, view.width - 2 * margin);
  const minWidth = Math.min(Math.max(anchor.right - anchor.left, minWidthFloor), availW);
  const maxWidth = Math.min(maxWidthLimit, Math.max(minWidth, availW));
  const rawLeft = align === 'right' ? anchor.right - minWidth : anchor.left;
  const left = Math.max(margin, Math.min(rawLeft, view.width - minWidth - margin));
  const below = view.height - anchor.bottom - margin - gap;
  const above = anchor.top - margin - gap;
  if (wanted <= below || (below >= above && below >= 120)) {
    return {
      placement: 'bottom',
      left,
      minWidth,
      maxWidth,
      top: anchor.bottom + gap,
      maxHeight: Math.max(80, below),
    };
  }
  return {
    placement: 'top',
    left,
    minWidth,
    maxWidth,
    bottom: view.height - anchor.top + gap,
    maxHeight: Math.max(80, above),
  };
}

/** Places a flyout submenu beside its parent menu row (right when room allows,
 * otherwise left), clamped to the viewport. */
function placeSubmenu(
  rowRect: { left: number; top: number; right: number; bottom: number },
  parentRect: { left: number; right: number },
  width: number,
  estimatedHeight: number,
  view: { width: number; height: number },
): { left: number; top: number; maxHeight: number } {
  const margin = 8;
  const gap = 6;
  const rightSpace = view.width - parentRect.right - margin - gap;
  const left =
    rightSpace >= width || rightSpace >= parentRect.left - margin - gap
      ? Math.min(parentRect.right + gap, Math.max(margin, view.width - width - margin))
      : Math.max(margin, parentRect.left - gap - width);
  const maxHeight = Math.max(100, view.height - 2 * margin);
  const clampedH = Math.min(estimatedHeight, maxHeight);
  const top = Math.max(margin, Math.min(rowRect.top - 6, view.height - clampedH - margin));
  return { left, top, maxHeight };
}

export function ConfigSelect({
  option,
  label,
  nameOf,
  disabled,
  fullBlocked,
  onSet,
  align = 'right',
}: {
  option: ConfigOption;
  label: string;
  nameOf?: (v: ConfigValue) => string;
  disabled: boolean;
  fullBlocked: FullBlocked;
  onSet: (id: string, value: string) => Promise<void>;
  align?: 'left' | 'right';
}) {
  /** The value asked for until the host took it. */
  const [asked, setAsked] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<ConfigMenuPlace>();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const popupId = useId();

  const value = asked ?? option.currentValue;
  const values = option.options.some((o) => o.value === value) ? option.options : [{ value, name: value }, ...option.options];
  const blocked = (v: ConfigValue) => !!fullBlocked && v.full === true;
  const labelOf = (v: ConfigValue) => {
    const name = nameOf ? nameOf(v) : v.name;
    return blocked(v) ? t(fullBlocked === 'readOnly' ? 'conversation.config.fullReadOnly' : 'conversation.config.fullOff', { name }) : name;
  };
  const current = values.find((v) => v.value === value);
  const currentLabel = current ? labelOf(current) : value;
  const isDisabled = disabled || asked !== undefined;

  let title = option.description ? `${label}: ${option.description}` : label;
  if (fullBlocked === 'off' && values.some(blocked)) title += `\n${t('conversation.config.fullOffHint')}`;

  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus({ preventScroll: true });
  }, []);

  useDismiss(open, menuRef, () => close(false), buttonRef);

  const enabledIndexes = useMemo(
    () => values.map((v, i) => (!blocked(v) ? i : -1)).filter((i) => i >= 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [values, fullBlocked],
  );

  const openMenu = (preferred?: 'first' | 'last') => {
    if (isDisabled) return;
    const curIdx = values.findIndex((v) => v.value === value && !blocked(v));
    const init =
      preferred === 'last'
        ? (enabledIndexes[enabledIndexes.length - 1] ?? 0)
        : preferred === 'first'
          ? (enabledIndexes[0] ?? 0)
          : curIdx >= 0
            ? curIdx
            : (enabledIndexes[0] ?? 0);
    setActive(init);
    setOpen(true);
  };

  useEffect(() => {
    if (isDisabled && open) setOpen(false);
  }, [isDisabled, open]);

  const updatePlace = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const estimated = Math.min(Math.max(menuRef.current?.scrollHeight ?? 0, values.length * 32 + 12), 320);
    setPlace(
      placeConfigMenu(btn.getBoundingClientRect(), estimated, { width: window.innerWidth, height: window.innerHeight }, 300, 180, align),
    );
  }, [values.length, align]);

  useLayoutEffect(() => {
    if (!open) {
      setPlace(undefined);
      return;
    }
    updatePlace();
    menuRef.current?.focus({ preventScroll: true });
    window.addEventListener('resize', updatePlace);
    window.addEventListener('scroll', updatePlace, true);
    return () => {
      window.removeEventListener('resize', updatePlace);
      window.removeEventListener('scroll', updatePlace, true);
    };
  }, [open, updatePlace]);

  const choose = (v: ConfigValue) => {
    if (blocked(v)) return;
    close(true);
    if (v.value === value) return;
    setAsked(v.value);
    onSet(option.id, v.value).finally(() => setAsked(undefined));
  };

  const stepActive = (delta: number) => {
    if (!enabledIndexes.length) return;
    const pos = enabledIndexes.indexOf(active);
    const next = pos < 0 ? 0 : (pos + delta + enabledIndexes.length) % enabledIndexes.length;
    setActive(enabledIndexes[next]);
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      stepActive(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      stepActive(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      if (enabledIndexes.length) setActive(enabledIndexes[0]);
    } else if (e.key === 'End') {
      e.preventDefault();
      if (enabledIndexes.length) setActive(enabledIndexes[enabledIndexes.length - 1]);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const item = values[active];
      if (item && !blocked(item)) choose(item);
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="conv-select"
        data-config={option.category}
        data-value={value}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        aria-label={label}
        title={title}
        disabled={isDisabled}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(e) => {
          if (open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            openMenu();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            openMenu('last');
          }
        }}
      >
        <span className="conv-select-label ellipsis">{currentLabel}</span>
        <ChevronDown className="conv-select-chevron" aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={popupId}
            className="conv-select-menu"
            role="listbox"
            tabIndex={-1}
            data-config={option.category}
            data-placement={place?.placement}
            aria-label={label}
            aria-activedescendant={active >= 0 ? `${popupId}-${active}` : undefined}
            style={
              place
                ? {
                    left: place.left,
                    minWidth: place.minWidth,
                    maxWidth: place.maxWidth,
                    maxHeight: place.maxHeight,
                    ...(place.top !== undefined ? { top: place.top } : { bottom: place.bottom }),
                  }
                : { visibility: 'hidden' }
            }
            onKeyDown={onMenuKeyDown}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {values.map((v, i) => {
              const isBlocked = blocked(v);
              const isSelected = v.value === value;
              const isActive = i === active && !isBlocked;
              return (
                <div
                  key={v.value}
                  id={`${popupId}-${i}`}
                  role="option"
                  data-value={v.value}
                  data-full={isBlocked ? fullBlocked : undefined}
                  aria-selected={isSelected}
                  aria-disabled={isBlocked || undefined}
                  title={v.description}
                  className={['conv-select-option', isActive && 'active', isSelected && 'selected', isBlocked && 'disabled']
                    .filter(Boolean)
                    .join(' ')}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => !isBlocked && setActive(i)}
                  onClick={() => choose(v)}
                >
                  <span className="conv-select-option-text">
                    <span className="conv-select-option-label ellipsis">{labelOf(v)}</span>
                    {v.description && <span className="conv-select-option-desc ellipsis">{v.description}</span>}
                  </span>
                  {isSelected && <Check className="conv-select-option-check" aria-hidden />}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Combined Model + Effort selector styled after Claude Code's bottom-right
 * pill (`Opus 5.5 Medium`): clicking opens the model menu for this session,
 * with an Effort row that expands a flyout submenu on hover or click. Omits
 * "More models" and "Fast mode". */
export function ModelEffortSelect({
  model,
  effort,
  disabled,
  fullBlocked,
  onSet,
}: {
  model?: ConfigOption;
  effort?: ConfigOption;
  disabled: boolean;
  fullBlocked: FullBlocked;
  onSet: (id: string, value: string) => Promise<void>;
}) {
  // Standalone effort when the agent advertises effort without a model option.
  if (!model && effort) {
    return (
      <ConfigSelect
        option={effort}
        label={t('conversation.config.effort')}
        nameOf={effortName}
        disabled={disabled}
        fullBlocked={fullBlocked}
        onSet={onSet}
      />
    );
  }
  if (!model) return null;

  return <ModelEffortMenu model={model} effort={effort} disabled={disabled} onSet={onSet} />;
}

function ModelEffortMenu({
  model,
  effort,
  disabled,
  onSet,
}: {
  model: ConfigOption;
  effort?: ConfigOption;
  disabled: boolean;
  onSet: (id: string, value: string) => Promise<void>;
}) {
  const [askedModel, setAskedModel] = useState<string | undefined>(undefined);
  const [askedEffort, setAskedEffort] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [effortActive, setEffortActive] = useState(0);
  const [place, setPlace] = useState<ConfigMenuPlace>();
  const [subPlace, setSubPlace] = useState<{ left: number; top: number; maxHeight: number }>();

  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const effortRowRef = useRef<HTMLButtonElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const closeSubTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const popupId = useId();
  const subId = useId();

  const modelValue = askedModel ?? model.currentValue;
  const modelValues = model.options.some((o) => o.value === modelValue)
    ? model.options
    : [{ value: modelValue, name: modelValue }, ...model.options];
  const currentModel = modelValues.find((v) => v.value === modelValue);
  const currentModelLabel = currentModel ? currentModel.name : modelValue;

  const effortValue = effort ? (askedEffort ?? effort.currentValue) : undefined;
  const effortValues = useMemo(() => {
    if (!effort || effortValue === undefined) return [];
    return effort.options.some((o) => o.value === effortValue)
      ? effort.options
      : [{ value: effortValue, name: effortValue }, ...effort.options];
  }, [effort, effortValue]);
  const currentEffort = effortValues.find((v) => v.value === effortValue);
  const currentEffortLabel = currentEffort ? effortName(currentEffort) : effortValue;

  const hasEffort = !!(effort && effortValues.length > 0);
  const isDisabled = disabled || askedModel !== undefined || askedEffort !== undefined;
  const totalRows = modelValues.length + (hasEffort ? 1 : 0);
  const effortRowIdx = modelValues.length;

  const clearSubTimer = () => {
    if (closeSubTimer.current !== undefined) {
      clearTimeout(closeSubTimer.current);
      closeSubTimer.current = undefined;
    }
  };

  const closeAll = useCallback((returnFocus = false) => {
    clearSubTimer();
    setEffortOpen(false);
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus({ preventScroll: true });
  }, []);

  // Custom outside-click dismiss that recognizes both the primary menu and the effort flyout.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && (menuRef.current?.contains(target) || subRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      closeAll(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAll(true);
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, closeAll]);

  useEffect(() => () => clearSubTimer(), []);

  useEffect(() => {
    if (isDisabled && open) closeAll(false);
  }, [isDisabled, open, closeAll]);

  const openMenu = (preferred?: 'first' | 'last') => {
    if (isDisabled) return;
    const curIdx = modelValues.findIndex((v) => v.value === modelValue);
    const init = preferred === 'last' ? Math.max(0, totalRows - 1) : preferred === 'first' ? 0 : curIdx >= 0 ? curIdx : 0;
    setActive(init);
    setEffortOpen(false);
    setOpen(true);
  };

  const openEffortSub = useCallback(
    (focusSub = false) => {
      if (!hasEffort) return;
      clearSubTimer();
      const idx = effortValues.findIndex((v) => v.value === effortValue);
      setEffortActive(idx >= 0 ? idx : 0);
      setEffortOpen(true);
      if (focusSub) queueMicrotask(() => subRef.current?.focus({ preventScroll: true }));
    },
    [hasEffort, effortValues, effortValue],
  );

  const scheduleCloseSub = () => {
    clearSubTimer();
    closeSubTimer.current = setTimeout(() => setEffortOpen(false), 140);
  };

  const updatePlace = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const estimated = Math.min(Math.max(menuRef.current?.scrollHeight ?? 0, totalRows * 34 + 44), 360);
    setPlace(
      placeConfigMenu(btn.getBoundingClientRect(), estimated, { width: window.innerWidth, height: window.innerHeight }, 300, 220, 'right'),
    );
  }, [totalRows]);

  const updateSubPlace = useCallback(() => {
    const row = effortRowRef.current;
    const parent = menuRef.current;
    if (!row || !parent) return;
    const estimated = Math.min(Math.max(subRef.current?.scrollHeight ?? 0, effortValues.length * 36 + 64), 320);
    setSubPlace(
      placeSubmenu(row.getBoundingClientRect(), parent.getBoundingClientRect(), 240, estimated, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [effortValues.length]);

  useLayoutEffect(() => {
    if (!open) {
      setPlace(undefined);
      setSubPlace(undefined);
      return;
    }
    updatePlace();
    menuRef.current?.focus({ preventScroll: true });
    window.addEventListener('resize', updatePlace);
    window.addEventListener('scroll', updatePlace, true);
    return () => {
      window.removeEventListener('resize', updatePlace);
      window.removeEventListener('scroll', updatePlace, true);
    };
  }, [open, updatePlace]);

  useLayoutEffect(() => {
    if (!open || !effortOpen) {
      setSubPlace(undefined);
      return;
    }
    updateSubPlace();
    window.addEventListener('resize', updateSubPlace);
    window.addEventListener('scroll', updateSubPlace, true);
    return () => {
      window.removeEventListener('resize', updateSubPlace);
      window.removeEventListener('scroll', updateSubPlace, true);
    };
  }, [open, effortOpen, updateSubPlace, place]);

  const chooseModel = (v: ConfigValue) => {
    closeAll(true);
    if (v.value === modelValue) return;
    setAskedModel(v.value);
    onSet(model.id, v.value).finally(() => setAskedModel(undefined));
  };

  const chooseEffort = (v: ConfigValue) => {
    if (!effort) return;
    closeAll(true);
    if (v.value === effortValue) return;
    setAskedEffort(v.value);
    onSet(effort.id, v.value).finally(() => setAskedEffort(undefined));
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeAll(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = (active + 1) % totalRows;
      setActive(next);
      if (next !== effortRowIdx) setEffortOpen(false);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (active - 1 + totalRows) % totalRows;
      setActive(next);
      if (next !== effortRowIdx) setEffortOpen(false);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
      setEffortOpen(false);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(Math.max(0, totalRows - 1));
    } else if (e.key === 'ArrowRight' && hasEffort && active === effortRowIdx) {
      e.preventDefault();
      openEffortSub(true);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (hasEffort && active === effortRowIdx) {
        openEffortSub(true);
      } else {
        const item = modelValues[active];
        if (item) chooseModel(item);
      }
    } else if (e.key === 'Tab') {
      closeAll(false);
    }
  };

  const onSubKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      setEffortOpen(false);
      menuRef.current?.focus({ preventScroll: true });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setEffortActive((i) => (i + 1) % effortValues.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setEffortActive((i) => (i - 1 + effortValues.length) % effortValues.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setEffortActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setEffortActive(Math.max(0, effortValues.length - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const item = effortValues[effortActive];
      if (item) chooseEffort(item);
    } else if (e.key === 'Tab') {
      closeAll(false);
    }
  };

  const triggerLabel = hasEffort ? t('conversation.config.modelEffort') : t('conversation.config.model');
  const triggerTitle = hasEffort ? `${currentModelLabel} · ${currentEffortLabel}` : currentModelLabel;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="conv-select conv-model-effort"
        data-config="model"
        data-value={modelValue}
        data-effort={hasEffort ? effortValue : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        aria-label={triggerLabel}
        title={triggerTitle}
        disabled={isDisabled}
        onClick={() => (open ? closeAll(false) : openMenu())}
        onKeyDown={(e) => {
          if (open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            openMenu();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            openMenu('last');
          }
        }}
      >
        <span className="conv-me-model ellipsis">{currentModelLabel}</span>
        {hasEffort && <span className="conv-me-effort">{currentEffortLabel}</span>}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={popupId}
            className="conv-select-menu conv-me-menu"
            role="listbox"
            tabIndex={-1}
            data-config="model"
            data-placement={place?.placement}
            aria-label={triggerLabel}
            aria-activedescendant={active >= 0 ? `${popupId}-${active}` : undefined}
            style={
              place
                ? {
                    left: place.left,
                    minWidth: place.minWidth,
                    maxWidth: place.maxWidth,
                    maxHeight: place.maxHeight,
                    ...(place.top !== undefined ? { top: place.top } : { bottom: place.bottom }),
                  }
                : { visibility: 'hidden' }
            }
            onKeyDown={onMenuKeyDown}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="conv-menu-section-head">{t('conversation.config.modelSession')}</div>
            {modelValues.map((v, i) => {
              const isSelected = v.value === modelValue;
              const isActive = i === active;
              return (
                <div
                  key={v.value}
                  id={`${popupId}-${i}`}
                  role="option"
                  data-value={v.value}
                  aria-selected={isSelected}
                  title={v.description}
                  className={['conv-select-option', isActive && 'active', isSelected && 'selected'].filter(Boolean).join(' ')}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => {
                    setActive(i);
                    scheduleCloseSub();
                  }}
                  onClick={() => chooseModel(v)}
                >
                  <span className="conv-select-option-text">
                    <span className="conv-select-option-label ellipsis">{v.name}</span>
                    {v.description && <span className="conv-select-option-desc ellipsis">{v.description}</span>}
                  </span>
                  {isSelected && <Check className="conv-select-option-check" aria-hidden />}
                </div>
              );
            })}
            {hasEffort && (
              <>
                <div className="conv-menu-sep" role="separator" />
                <button
                  ref={effortRowRef}
                  type="button"
                  id={`${popupId}-${effortRowIdx}`}
                  role="menuitem"
                  data-config="thought_level"
                  aria-haspopup="listbox"
                  aria-expanded={effortOpen}
                  aria-controls={effortOpen ? subId : undefined}
                  className={['conv-select-option', 'conv-me-effort-row', active === effortRowIdx && 'active'].filter(Boolean).join(' ')}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => {
                    setActive(effortRowIdx);
                    openEffortSub(false);
                  }}
                  onMouseLeave={scheduleCloseSub}
                  onClick={() => openEffortSub(true)}
                >
                  <span className="conv-select-option-label">{t('conversation.config.effort')}</span>
                  <span className="conv-me-effort-val">{currentEffortLabel}</span>
                  <ChevronRight className="conv-me-effort-arrow" aria-hidden />
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
      {open &&
        effortOpen &&
        hasEffort &&
        createPortal(
          <div
            ref={subRef}
            id={subId}
            className="conv-select-menu conv-me-effort-sub"
            role="listbox"
            tabIndex={-1}
            data-config="thought_level"
            aria-label={t('conversation.config.effort')}
            aria-activedescendant={effortActive >= 0 ? `${subId}-${effortActive}` : undefined}
            style={
              subPlace
                ? {
                    left: subPlace.left,
                    top: subPlace.top,
                    width: 240,
                    maxHeight: subPlace.maxHeight,
                  }
                : { visibility: 'hidden' }
            }
            onMouseEnter={clearSubTimer}
            onMouseLeave={scheduleCloseSub}
            onKeyDown={onSubKeyDown}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="conv-me-effort-hint">{t('conversation.config.effortHint')}</div>
            {effortValues.map((v, i) => {
              const isSelected = v.value === effortValue;
              const isActive = i === effortActive;
              return (
                <div
                  key={v.value}
                  id={`${subId}-${i}`}
                  role="option"
                  data-value={v.value}
                  aria-selected={isSelected}
                  title={v.description}
                  className={['conv-select-option', isActive && 'active', isSelected && 'selected'].filter(Boolean).join(' ')}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setEffortActive(i)}
                  onClick={() => chooseEffort(v)}
                >
                  <span className="conv-select-option-text">
                    <span className="conv-select-option-label ellipsis">{effortName(v)}</span>
                    {v.description && <span className="conv-select-option-desc ellipsis">{v.description}</span>}
                  </span>
                  {isSelected && <Check className="conv-select-option-check" aria-hidden />}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

/** `+` button inside the left of the composer input bar: opens a compact menu
 * combining workspace file picker, image picker, and Markdown preview toggle. */
export function PlusMenu({
  buttonRef,
  canBrowseFiles,
  canImages,
  preview,
  modLabel,
  disabled,
  onPickFiles,
  onPickImages,
  onTogglePreview,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  canBrowseFiles: boolean;
  canImages: boolean;
  preview: boolean;
  modLabel: string;
  disabled: boolean;
  onPickFiles(): void;
  onPickImages(): void;
  onTogglePreview(): void;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<ConfigMenuPlace>();
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback(
    (returnFocus = false) => {
      setOpen(false);
      if (returnFocus) buttonRef.current?.focus({ preventScroll: true });
    },
    [buttonRef],
  );

  useDismiss(open, menuRef, () => close(false), buttonRef);

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  const updatePlace = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    setPlace(placeConfigMenu(btn.getBoundingClientRect(), 140, { width: window.innerWidth, height: window.innerHeight }, 260, 210, 'left'));
  }, [buttonRef]);

  useLayoutEffect(() => {
    if (!open) {
      setPlace(undefined);
      return;
    }
    updatePlace();
    window.addEventListener('resize', updatePlace);
    window.addEventListener('scroll', updatePlace, true);
    return () => {
      window.removeEventListener('resize', updatePlace);
      window.removeEventListener('scroll', updatePlace, true);
    };
  }, [open, updatePlace]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="conv-plus-btn"
        aria-label={t('conversation.attach.menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={t('conversation.attach.menu')}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <Plus aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            className="conv-select-menu conv-plus-menu"
            role="menu"
            data-placement={place?.placement}
            style={
              place
                ? {
                    left: place.left,
                    minWidth: place.minWidth,
                    maxWidth: place.maxWidth,
                    ...(place.top !== undefined ? { top: place.top } : { bottom: place.bottom }),
                  }
                : { visibility: 'hidden' }
            }
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close(true);
              }
            }}
          >
            {canBrowseFiles && (
              <button
                type="button"
                role="menuitem"
                className="conv-plus-item conv-attach-file"
                title={t('conversation.attach.pickFilesHint')}
                onClick={() => {
                  close(false);
                  onPickFiles();
                }}
              >
                <Paperclip aria-hidden />
                <span>{t('conversation.attach.filesItem')}</span>
              </button>
            )}
            {canImages && (
              <button
                type="button"
                role="menuitem"
                className="conv-plus-item conv-attach"
                title={t('conversation.attach.pickHint', { max: formatBytes(MAX_IMAGE) })}
                onClick={() => {
                  close(false);
                  onPickImages();
                }}
              >
                <ImagePlus aria-hidden />
                <span>{t('conversation.attach.imagesItem')}</span>
              </button>
            )}
            {(canBrowseFiles || canImages) && <div className="conv-menu-sep" role="separator" />}
            <button
              type="button"
              role="menuitem"
              className="conv-plus-item conv-preview-toggle"
              aria-pressed={preview}
              title={t(preview ? 'conversation.markdown.editHint' : 'conversation.markdown.previewHint', { key: `${modLabel}+Shift+P` })}
              onClick={() => {
                close(false);
                onTogglePreview();
              }}
            >
              {preview ? <Pencil aria-hidden /> : <Eye aria-hidden />}
              <span>{preview ? t('conversation.markdown.edit') : t('conversation.markdown.preview')}</span>
              <span className="conv-plus-shortcut">{`${modLabel}⇧P`}</span>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

export interface UsageLineProps {
  usage: Usage;
  /** Whether the agent supports manual compaction. */
  canCompact?: boolean;
  /** Whether manual compaction can run right now. */
  compactReady?: boolean;
  /** Tooltip explanation when compaction is currently unavailable. */
  compactDisabledReason?: string;
  /** True while compaction is running. */
  compacting?: boolean;
  /** Runs manual compaction, optionally with user focus instructions. */
  onCompact?(instructions?: string): Promise<void> | void;
}

const RING_RADIUS = 6.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** Current-session context usage ring indicator: circular progress ring that
 * shows session context details (percentage, tokens, session cost) on hover
 * and expands manual compaction controls on click when supported. Quota/rate-
 * limit windows belong to the AI Usage plugin's status bar item rather than here. */
export function UsageLine({ usage, canCompact, compactReady, compactDisabledReason, compacting, onCompact }: UsageLineProps) {
  const pct = contextPercent(usage);
  const level = (p: number) => (p >= 90 ? 'high' : p >= 75 ? 'mid' : undefined);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [place, setPlace] = useState<ConfigMenuPlace>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const instrRef = useRef<HTMLInputElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const open = hoverOpen || pinned;
  const interactive = !!(canCompact && onCompact);
  const stale = usage.stale === true;
  const hasAny = pct !== undefined || usage.used > 0 || !!usage.cost || stale || (interactive && !!compacting);

  const clearHoverTimer = () => {
    if (hoverTimer.current !== undefined) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = undefined;
    }
  };

  const closeAll = useCallback((returnFocus = false) => {
    clearHoverTimer();
    setHoverOpen(false);
    setPinned(false);
    setInstructions('');
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  useDismiss(pinned, popRef, () => closeAll(false), triggerRef);

  useEffect(() => () => clearHoverTimer(), []);

  useEffect(() => {
    if ((!compactReady || compacting) && pinned && interactive) {
      setInstructions('');
    }
  }, [compactReady, compacting, pinned, interactive]);

  const updatePlace = useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const estimated = pinned && interactive && compactReady ? 190 : 120;
    setPlace(
      placeConfigMenu(btn.getBoundingClientRect(), estimated, { width: window.innerWidth, height: window.innerHeight }, 290, 240, 'right'),
    );
  }, [pinned, interactive, compactReady]);

  useLayoutEffect(() => {
    if (!open) {
      setPlace(undefined);
      return;
    }
    updatePlace();
    if (pinned && interactive && compactReady && !compacting) instrRef.current?.focus({ preventScroll: true });
    window.addEventListener('resize', updatePlace);
    window.addEventListener('scroll', updatePlace, true);
    return () => {
      window.removeEventListener('resize', updatePlace);
      window.removeEventListener('scroll', updatePlace, true);
    };
  }, [open, pinned, interactive, compactReady, compacting, updatePlace]);

  if (!hasAny) return null;

  const n = stale ? 0 : pct !== undefined ? Math.round(pct) : undefined;
  const ratio = n !== undefined ? Math.max(0, Math.min(100, n)) / 100 : 0;
  const offset = RING_CIRCUMFERENCE * (1 - ratio);
  const lvl = !stale && pct !== undefined ? level(pct) : undefined;

  const baseCtxTitle = stale
    ? t('conversation.usage.stale')
    : usage.size > 0
      ? t('conversation.context', { used: formatTokens(usage.used), size: formatTokens(usage.size) })
      : n !== undefined
        ? t('conversation.usage.context', { pct: n })
        : usage.used > 0
          ? t('conversation.usage.tokens', { n: formatTokens(usage.used) })
          : t('conversation.usage.sessionTitle');
  const ctxTitle = interactive
    ? `${baseCtxTitle}\n${
        compacting ? t('conversation.compact.running') : compactReady ? t('conversation.compact.clickHint') : (compactDisabledReason ?? '')
      }`.trim()
    : baseCtxTitle;

  const runCompact = () => {
    const note = instructions.trim() || undefined;
    closeAll(false);
    void onCompact?.(note);
  };

  const onEnter = () => {
    clearHoverTimer();
    setHoverOpen(true);
  };
  const onLeave = () => {
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => setHoverOpen(false), 140);
  };

  return (
    <div className="conv-usage" aria-label={t('conversation.usage.label')}>
      <button
        ref={triggerRef}
        type="button"
        className={interactive ? 'conv-ctx-ring-btn conv-compact-btn' : 'conv-ctx-ring-btn'}
        role={n !== undefined ? 'meter' : undefined}
        aria-label={t('conversation.contextUsed')}
        aria-valuemin={n !== undefined ? 0 : undefined}
        aria-valuemax={n !== undefined ? 100 : undefined}
        aria-valuenow={n}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={compacting || undefined}
        data-level={lvl}
        data-stale={stale ? 'true' : undefined}
        title={ctxTitle}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onClick={() => {
          clearHoverTimer();
          setPinned((p) => !p);
        }}
      >
        {compacting ? (
          <LoaderCircle className="conv-spin conv-ring-spin" aria-hidden />
        ) : (
          <svg className="conv-ring-svg" viewBox="0 0 18 18" aria-hidden="true">
            <circle className="conv-ring-track" cx="9" cy="9" r={RING_RADIUS} />
            <circle
              className="conv-ring-fill"
              cx="9"
              cy="9"
              r={RING_RADIUS}
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={offset}
            />
          </svg>
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="conv-compact-popover conv-ctx-popover"
            role="dialog"
            aria-label={t('conversation.usage.sessionTitle')}
            style={
              place
                ? {
                    left: place.left,
                    ...(place.top !== undefined ? { top: place.top } : { bottom: place.bottom }),
                  }
                : { visibility: 'hidden' }
            }
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeAll(true);
              }
            }}
          >
            <div className="conv-ctx-head">
              <span className="conv-ctx-head-title">{t('conversation.usage.sessionTitle')}</span>
              {n !== undefined && <span className="conv-ctx-pct">{n}%</span>}
            </div>
            {n !== undefined && (
              <div className="conv-ctx-bar" data-level={lvl}>
                <span style={{ width: `${Math.min(100, Math.max(0, n))}%` }} />
              </div>
            )}
            <div className="conv-ctx-details">
              {stale ? (
                <div className="conv-ctx-row conv-ctx-stale">
                  <span>{t('conversation.usage.stale')}</span>
                </div>
              ) : usage.size > 0 ? (
                <div className="conv-ctx-row">
                  <span>{t('conversation.context', { used: formatTokens(usage.used), size: formatTokens(usage.size) })}</span>
                </div>
              ) : usage.used > 0 ? (
                <div className="conv-ctx-row">
                  <span className="conv-usage-tokens">{t('conversation.usage.tokens', { n: formatTokens(usage.used) })}</span>
                </div>
              ) : null}
              {stale && usage.size > 0 && (
                <div className="conv-ctx-row">
                  <span>{t('conversation.context', { used: formatTokens(0), size: formatTokens(usage.size) })}</span>
                </div>
              )}
              {usage.cost && (
                <div className="conv-ctx-row">
                  <span>{t('conversation.usage.costLabel')}</span>
                  <span className="conv-usage-cost" title={t('conversation.usage.costTitle')}>
                    {formatCost(usage.cost, locale)}
                  </span>
                </div>
              )}
            </div>
            {interactive && (
              <div className="conv-ctx-compact">
                {compacting ? (
                  <div className="conv-ctx-note">
                    <LoaderCircle className="conv-spin" aria-hidden />
                    <span>{t('conversation.compact.running')}</span>
                  </div>
                ) : !compactReady ? (
                  compactDisabledReason ? (
                    <div className="conv-ctx-note">{compactDisabledReason}</div>
                  ) : null
                ) : pinned ? (
                  <>
                    <div className="conv-compact-desc">{t('conversation.compact.desc')}</div>
                    <input
                      ref={instrRef}
                      type="text"
                      className="conv-compact-input"
                      value={instructions}
                      placeholder={t('conversation.compact.instructions')}
                      aria-label={t('conversation.compact.instructions')}
                      onChange={(e) => setInstructions(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          runCompact();
                        }
                      }}
                    />
                    <div className="conv-compact-actions">
                      <button type="button" className="ghost sm" onClick={() => closeAll(true)}>
                        {t('conversation.compact.cancel')}
                      </button>
                      <button type="button" className="primary sm" onClick={runCompact}>
                        {t('conversation.compact.confirm')}
                      </button>
                    </div>
                  </>
                ) : (
                  <button type="button" className="conv-ctx-compact-link" onClick={() => setPinned(true)}>
                    {t('conversation.compact.clickHint')}
                  </button>
                )}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

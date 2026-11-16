// In-app dialogs replacing the browser's confirm() and prompt(): callers
// await a result, Dialogs.tsx renders the request. One dialog is shown at a
// time; a new request cancels the previous one.

import { create } from 'zustand';
import { t } from './i18n';

export interface NewWorkspace {
  cwd: string;
  label: string;
}

export type DialogRequest =
  | {
      kind: 'confirm';
      title: string;
      message: string;
      confirm: string;
      danger?: boolean;
      /** A checkbox shown under the message, with its initial state. */
      check?: string;
      checked?: boolean;
      /** A third answer between Cancel and confirm (Don't Save). */
      alt?: string;
      /** What the Cancel button says (Skip), Cancel by default. */
      cancel?: string;
      /** A fourth answer, at the start of the row (Skip beside Cancel). */
      extra?: string;
      resolve(ok: boolean, checked?: boolean, alt?: boolean, extra?: boolean): void;
    }
  | {
      kind: 'workspace';
      m: string;
      cwd: string;
      /** Set when an existing workspace is edited: its name. Its directory
       * may then be left empty. */
      edit?: { name: string };
      resolve(v: NewWorkspace | undefined): void;
    }
  | { kind: 'download'; m: string; dir: string; resolve(v: undefined): void }
  | {
      kind: 'risk';
      title: string;
      /** The paragraph before the list of what is at risk, and those after. */
      intro: string;
      points: string[];
      outro: string[];
      /** The box to tick before the confirm button can be pressed. */
      check: string;
      confirm: string;
      resolve(ok: boolean): void;
    };

export const useDialog = create<{ current?: DialogRequest }>(() => ({}));

function show(req: DialogRequest) {
  const prev = useDialog.getState().current;
  if (prev?.kind === 'confirm' || prev?.kind === 'risk') prev.resolve(false);
  else if (prev) prev.resolve(undefined);
  useDialog.setState({ current: req });
}

/** Closes the dialog shown for req (if it still is). */
export function closeDialog(req: DialogRequest) {
  if (useDialog.getState().current === req) useDialog.setState({ current: undefined });
}

export function confirmDialog(opts: { title: string; message: string; confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => show({ kind: 'confirm', ...opts, resolve }));
}

/** A confirmation with a checkbox: resolves with the box's state when
 * confirmed, undefined when cancelled. */
export function confirmCheckDialog(opts: {
  title: string;
  message: string;
  confirm: string;
  danger?: boolean;
  check: string;
  checked: boolean;
}): Promise<{ checked: boolean } | undefined> {
  return new Promise((resolve) =>
    show({ kind: 'confirm', ...opts, resolve: (ok, checked) => resolve(ok ? { checked: !!checked } : undefined) }),
  );
}

/** A question with three answers, cancel (Escape too), alt and confirm,
 * a fourth one (extra) when given, and a box to tick: resolves with the
 * answer and the box's state. */
export function choiceDialog(opts: {
  title: string;
  message: string;
  confirm: string;
  alt: string;
  cancel?: string;
  extra?: string;
  check?: string;
  checked?: boolean;
}): Promise<{ answer: 'confirm' | 'alt' | 'extra' | 'cancel'; checked: boolean }> {
  return new Promise((resolve) =>
    show({
      kind: 'confirm',
      ...opts,
      resolve: (ok, checked, alt, extra) =>
        resolve({ answer: ok ? 'confirm' : alt ? 'alt' : extra ? 'extra' : 'cancel', checked: !!checked }),
    }),
  );
}

/** Asks the user to accept a risk: what is at risk, a box to tick (I
 * understand…) and the confirm button, which works only once it is
 * ticked. Resolves true when accepted; Cancel and Escape resolve false. */
export function riskDialog(opts: {
  title: string;
  intro: string;
  points: string[];
  outro: string[];
  check: string;
  confirm: string;
}): Promise<boolean> {
  return new Promise((resolve) => show({ kind: 'risk', ...opts, resolve }));
}

/** Asks whether to save changes before they are closed: save, discard
 * (Don't Save) or cancel (Escape, Cancel). */
export function saveChangesDialog(opts: { title: string; message: string }): Promise<'save' | 'discard' | 'cancel'> {
  return new Promise((resolve) =>
    show({
      kind: 'confirm',
      ...opts,
      confirm: t('unsaved.save'),
      alt: t('unsaved.discard'),
      resolve: (ok, _checked, alt) => resolve(ok ? 'save' : alt ? 'discard' : 'cancel'),
    }),
  );
}

/** Asks for the working directory and name of a new workspace on machine m. */
export function newWorkspaceDialog(m: string, cwd: string): Promise<NewWorkspace | undefined> {
  return new Promise((resolve) => show({ kind: 'workspace', m, cwd, resolve }));
}

/** Asks for a workspace's new name and directory (empty: its new terminals
 * start in the focused one's). */
export function editWorkspaceDialog(m: string, cwd: string, name: string): Promise<NewWorkspace | undefined> {
  return new Promise((resolve) => show({ kind: 'workspace', m, cwd, edit: { name }, resolve }));
}

/** Lets the user choose entries of directory dir (and the directories
 * around it) on machine m to download; resolves when the dialog closes. */
export function downloadDialog(m: string, dir: string): Promise<undefined> {
  return new Promise((resolve) => show({ kind: 'download', m, dir, resolve }));
}

/** Splits a typed path into the directory to list and the name prefix to
 * match: "~/src/we" → ["~/src", "we"], "/opt/" → ["/opt", ""]. */
export function completionParts(value: string): [dir: string, prefix: string] {
  const i = value.lastIndexOf('/');
  if (i < 0) return [value === '~' ? '~' : '', value === '~' ? '' : value];
  return [value.slice(0, i) || '/', value.slice(i + 1)];
}

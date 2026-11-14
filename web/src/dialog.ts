// In-app dialogs replacing the browser's confirm() and prompt(): callers
// await a result, Dialogs.tsx renders the request. One dialog is shown at a
// time; a new request cancels the previous one.

import { create } from 'zustand';

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
      resolve(ok: boolean, checked?: boolean): void;
    }
  | { kind: 'newWorkspace'; m: string; cwd: string; resolve(v: NewWorkspace | undefined): void }
  | { kind: 'download'; m: string; dir: string; resolve(v: undefined): void };

export const useDialog = create<{ current?: DialogRequest }>(() => ({}));

function show(req: DialogRequest) {
  const prev = useDialog.getState().current;
  if (prev?.kind === 'confirm') prev.resolve(false);
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

/** Asks for the working directory and name of a new workspace on machine m. */
export function newWorkspaceDialog(m: string, cwd: string): Promise<NewWorkspace | undefined> {
  return new Promise((resolve) => show({ kind: 'newWorkspace', m, cwd, resolve }));
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
